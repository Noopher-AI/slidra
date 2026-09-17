#!/usr/bin/env node
// A scripted fake ACP agent speaking real JSON-RPC over stdio — the
// counterparty for the test architecture's Seam B. It simulates Claude
// Code; it is not a Slidra module, so driving it over stdio is scripting
// a protocol boundary, not self-verification.
//
// Behaviour is configured entirely through environment variables so each
// test can script a different scenario without command-line plumbing:
//
//   FAKE_AGENT_LOG        - path this script appends one JSON line to per
//                            `session/prompt` call it receives, so tests can
//                            inspect exactly what the client sent (the
//                            editorial brief as prompt #0, content-block shape,
//                            sessionId reuse). Also logs one line per
//                            `session/new` call, carrying the `cwd` it
//                            received.
//   FAKE_AGENT_CONFIG     - JSON: { authRequired?: boolean, replies?: string[][],
//                            failFirstAttemptMarkerPath?: string,
//                            models?: { currentModelId, availableModels }   (claude-code-acp's shape),
//                            modelConfigOption?: { currentValue, options } (codex-acp's shape) }
//                            models: returned as `session/new`'s `models`;
//                            `session/set_model` then moves currentModelId and
//                            logs { setModel }. modelConfigOption: returned as
//                            a `configOptions` entry with category "model";
//                            `session/set_config_option` moves currentValue
//                            and logs { setConfigOption }.
//                            replies[i] are the text chunks streamed back as
//                            separate agent_message_chunk updates for the
//                            i-th `session/prompt` call (0 = the editorial brief).
//                            Missing entries fall back to a single echo chunk.
//                            failFirstAttemptMarkerPath: when set, the FIRST
//                            process (across however many separate spawns of
//                            this script share the same marker path) to see
//                            the marker file absent creates it and fails
//                            `newSession` with authRequired; every later
//                            spawn finds the marker present and proceeds
//                            normally. Used to script "first start fails,
//                            retry succeeds" across a real subprocess
//                            respawn.
//                            exitDuringPromptIndex: when the `session/prompt`
//                            call at this index arrives, the process exits
//                            immediately (process.exit(1)) instead of
//                            replying — no response, no further stdio. Used
//                            to script "the adapter dies mid-turn", which
//                            must not deadlock the chat forever. Paired
//                            with exitOnceMarkerPath so
//                            a respawned process (the session recovering on
//                            the next message) does not exit again.
//                            exitOnceMarkerPath: when set together with
//                            exitDuringPromptIndex, only the first process
//                            (across however many spawns share this marker
//                            path) to see the marker absent creates it and
//                            exits; every later spawn finds the marker
//                            present and replies normally instead.
//                            requestPermissionOnPromptIndex: at this prompt
//                            index, call session/request_permission before
//                            streaming replies. permissionCommand (string,
//                            default "slidra ls") becomes
//                            toolCall.rawInput.command — this is where
//                            the allowlist reads the shell command
//                            from. The outcome is logged as
//                            `{ permissionOutcome }`. permissionOptions
//                            (array, default [allow_once, reject_once]):
//                            overrides the offered option list, used to
//                            script an adapter that offers only
//                            `allow_always`.
//                            readTextFileOnPromptIndex / readTextFilePath /
//                            readTextFileLine / readTextFileLimit: at this
//                            prompt index, call fs/read_text_file for the
//                            given virtual path. Logs
//                            `{ readTextFileResult: content }` on success or
//                            `{ readTextFileError: { code, message } }` on
//                            failure. readTextFileEveryPromptFrom: like
//                            readTextFileOnPromptIndex but repeats the same
//                            read at every prompt index from this one
//                            onward — used to prove a change made between
//                            two turns is visible on the second read.
//                            toolCallOnPromptIndex: at this prompt index,
//                            stream a command tool call's whole life cycle
//                            as session/update notifications: a `tool_call` carrying
//                            rawInput.command = toolCallCommand (default
//                            "slidra text set ..."), then a
//                            `tool_call_update` moving it to in_progress,
//                            then a final `tool_call_update` whose status is
//                            toolCallOutcome ("completed" by default,
//                            "failed" to script a command that died) and
//                            whose content carries toolCallOutput, if given.
//                            toolCallOmitCommand: the same life cycle but
//                            with no `command` key in rawInput at all — a
//                            tool call that is not a shell command, which
//                            must never reach the author's screen.
//                            writeTextFileOnPromptIndex / writeTextFilePath /
//                            writeTextFileContent: at this prompt index,
//                            call fs/write_text_file (this must
//                            always fail). Logs
//                            `{ writeTextFileError: { code, message } }` on
//                            failure or `{ writeTextFileResult: true }` if
//                            it unexpectedly succeeds.
//                            availableCommands: array of
//                            { name, description } — sent as one
//                            `available_commands_update` right after
//                            `newSession` returns its response (never
//                            folded into an author turn — see session.ts's
//                            own comment on why the real update must arrive
//                            outside `relayingCurrentTurn`).
//                            availableCommandsUpdateOnPromptIndex +
//                            availableCommandsUpdate: at this prompt index,
//                            sends a second `available_commands_update`
//                            carrying availableCommandsUpdate wholesale (a
//                            full replacement, same as a real agent
//                            re-reporting its list) — used to prove a
//                            client subscribed to `available-commands`
//                            actually recomputes on a later report, not
//                            only the first one.
//
// Every process also logs its own pid as the very first log line, so tests
// can check with `process.kill(pid, 0)` whether a given spawn is still
// alive — the direct evidence for "a failed start must not leak its
// subprocess".

import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import path from "node:path";

const config = JSON.parse(process.env.FAKE_AGENT_CONFIG ?? "{}");
const logPath = process.env.FAKE_AGENT_LOG;

// stderrLine: whatever a real adapter would write to its own stderr. serve
// forwards it tagged with the adapter's label instead of discarding it.
if (config.stderrLine) process.stderr.write(`${config.stderrLine}\n`);

// The cwd the client handed us in `session/new` (see `newSession` below) —
// kept so `prompt` can build an absolute `fs/read_text_file` path the same
// way a real, conforming ACP agent does: resolve the cwd it was given,
// then join the relative path onto that resolved form. This is what
// actually reproduces the `/var` vs `/private/var` mismatch a real
// `claude-code-acp` 0.12.6 was probed sending on macOS.
let sessionCwd;

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

log({ pid: process.pid });

// Mutable copies of the scripted model state, so a switch is visible on the
// next GET the same way it would be on a real adapter.
const modelState = config.models ? { ...config.models, availableModels: [...config.models.availableModels] } : { currentModelId: "", availableModels: [] };
const modelOption = config.modelConfigOption ? { ...config.modelConfigOption } : { currentValue: "", options: [] };
function configOptions() {
  return [
    { id: "mode", name: "Approval Preset", category: "mode", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Default" }] },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: modelOption.currentValue, options: modelOption.options },
  ];
}

let promptCount = 0;

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: config.authRequired ? [{ id: "fake-login", name: "Fake Login" }] : [],
    };
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(params) {
    // Logged so tests can assert on exactly what cwd the client sent
    // (never a real project path, never under SLIDRA_HOME), and on the MCP
    // allow-list the client sent alongside it (NOOP-617 AC3).
    log({ newSessionCwd: params.cwd });
    log({ newSessionMcpServers: params.mcpServers });
    sessionCwd = params.cwd;

    const markerPath = config.failFirstAttemptMarkerPath;
    if (markerPath && !existsSync(markerPath)) {
      writeFileSync(markerPath, String(process.pid));
      throw acp.RequestError.authRequired();
    }

    if (config.authRequired) {
      throw acp.RequestError.authRequired();
    }

    if (config.availableCommands) {
      // Sent after newSession's own response is decided but before it is
      // returned — a conforming agent's initial report lands between
      // `session/new` and the first author turn, never folded into one
      // (`relayingCurrentTurn` must not gate this).
      await this.connection.sessionUpdate({
        sessionId: "fake-session-1",
        update: { sessionUpdate: "available_commands_update", availableCommands: config.availableCommands },
      });
    }

    const response = { sessionId: "fake-session-1" };
    if (config.models) response.models = modelState;
    if (config.modelConfigOption) response.configOptions = configOptions();
    return response;
  }

  async unstable_setSessionModel(params) {
    log({ setModel: params.modelId });
    if (!modelState.availableModels.some((model) => model.modelId === params.modelId)) {
      throw acp.RequestError.invalidParams({ modelId: params.modelId });
    }
    modelState.currentModelId = params.modelId;
    return {};
  }

  async extMethod(method, params) {
    if (method === "session/set_model") return this.unstable_setSessionModel(params);
    throw acp.RequestError.methodNotFound(method);
  }

  async setSessionConfigOption(params) {
    log({ setConfigOption: { configId: params.configId, value: params.value } });
    if (params.configId !== "model" || !modelOption.options.some((option) => option.value === params.value)) {
      throw acp.RequestError.invalidParams({ configId: params.configId, value: params.value });
    }
    modelOption.currentValue = params.value;
    return { configOptions: configOptions() };
  }

  async prompt(params) {
    log({ sessionId: params.sessionId, prompt: params.prompt });

    const index = promptCount++;

    if (config.exitDuringPromptIndex === index) {
      const markerPath = config.exitOnceMarkerPath;
      const alreadyExited = markerPath && existsSync(markerPath);
      if (!markerPath || !alreadyExited) {
        if (markerPath) writeFileSync(markerPath, String(process.pid));
        // Simulates the adapter dying mid-request: no response is ever
        // sent, stdio just goes away. process.exit() rather than a thrown
        // error, so this matches a real crash/kill, not a clean JSON-RPC
        // error reply.
        process.exit(1);
      }
    }

    const replies = config.replies?.[index] ?? [`reply to message ${index} `];

    if (config.requestPermissionOnPromptIndex === index) {
      const response = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "fake-tool-call",
          title: "test tool call",
          // permissionOmitCommand scripts a tool call whose rawInput carries
          // no `command` key at all — the "cannot determine the command"
          // case the allowlist must fail closed on.
          // permissionRawInput: an arbitrary raw input shape, for the case
          // where the command cannot be read out of it at all (a shell
          // shape this client does not know) but a protected path is still
          // sitting in there somewhere.
          rawInput: config.permissionRawInput ?? (config.permissionOmitCommand ? {} : { command: config.permissionCommand ?? "slidra ls" }),
        },
        // permissionOptions: overrides the default option list below —
        // used to script an adapter that offers only
        // `allow_always` (no `allow_once`), which the client must refuse
        // rather than accept as a persistent grant.
        options: config.permissionOptions ?? [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      log({ permissionOutcome: response.outcome });
      // abortTurnAfterPermission: Codex turns a refusal into an abort of
      // the whole turn — the prompt is answered `cancelled` even though
      // nobody ever called `session/cancel`.
      if (config.abortTurnAfterPermission) return { stopReason: "cancelled" };
    }

    const shouldReadTextFile =
      config.readTextFileOnPromptIndex === index ||
      (config.readTextFileEveryPromptFrom !== undefined && index >= config.readTextFileEveryPromptFrom);
    if (shouldReadTextFile) {
      try {
        // readTextFileAbsoluteUnderCwd: send an *absolute* path built by
        // resolving the session cwd we were given and joining the relative
        // virtual path onto it — the shape a real conforming agent sends,
        // as opposed to readTextFilePath, which is sent verbatim (used for
        // plain relative paths and for absolute paths that are
        // deliberately outside the session cwd).
        const requestedPath = config.readTextFileAbsoluteUnderCwd
          ? path.join(realpathSync(sessionCwd), config.readTextFileAbsoluteUnderCwd)
          : config.readTextFilePath;
        const response = await this.connection.readTextFile({
          sessionId: params.sessionId,
          path: requestedPath,
          line: config.readTextFileLine ?? null,
          limit: config.readTextFileLimit ?? null,
        });
        log({ readTextFileResult: response.content });
      } catch (error) {
        log({ readTextFileError: { code: error.code, message: error.message } });
      }
    }

    if (config.toolCallOnPromptIndex === index) {
      const toolCallId = "fake-command-call";
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Run command",
          kind: "execute",
          status: "pending",
          rawInput: config.toolCallOmitCommand
            ? { description: "not a shell command" }
            : { command: config.toolCallCommand ?? "slidra text set --id p1 --element-id el-1 --text New Title" },
        },
      });
      // permissionForToolCall: ask permission for *this* tool call, between
      // its announcement and its outcome — the real shape of a command the
      // allowlist refuses (claude-code-acp 0.16.2 then reports the tool
      // call as failed with its own "the user rejected this" text).
      if (config.permissionForToolCall) {
        const response = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: config.permissionForToolCallOmitInput
            ? { toolCallId, title: "Run command" }
            : { toolCallId, title: "Run command", rawInput: { command: config.toolCallCommand } },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        log({ permissionOutcome: response.outcome });
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
      });
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: config.toolCallOutcome ?? "completed",
          rawOutput: config.toolCallRawOutput,
          content:
            config.toolCallOutput === undefined
              ? undefined
              : [{ type: "content", content: { type: "text", text: config.toolCallOutput } }],
        },
      });
    }

    if (config.availableCommandsUpdateOnPromptIndex === index) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: config.availableCommandsUpdate ?? [],
        },
      });
    }

    if (config.writeTextFileOnPromptIndex === index) {
      try {
        await this.connection.writeTextFile({
          sessionId: params.sessionId,
          path: config.writeTextFilePath,
          content: config.writeTextFileContent ?? "",
        });
        log({ writeTextFileResult: true });
      } catch (error) {
        log({ writeTextFileError: { code: error.code, message: error.message } });
      }
    }

    for (const chunk of replies) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      });
    }

    // `holdPromptOnIndex` keeps this turn open for `holdPromptMs`
    // (default 10 s) so a test has a window to `session/cancel` it. A real
    // agent answers the original prompt with `cancelled` once it has
    // stopped; this fixture does the same the moment `cancel` arrives,
    // and `end_turn` if the hold simply runs out.
    if (config.holdPromptOnIndex === index) {
      const stopReason = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve("end_turn"), config.holdPromptMs ?? 10_000);
        this.releaseHold = () => {
          clearTimeout(timer);
          resolve("cancelled");
        };
      });
      this.releaseHold = undefined;
      log({ heldPromptEnded: stopReason });
      if (stopReason === "cancelled" && config.lateActivityAfterCancel) {
        // Mimics claude-code-acp, whose model keeps going after
        // `session/cancel` — updates and a permission request arrive
        // with no prompt in flight. Fired after this response is sent.
        setTimeout(async () => {
          for (const text of ["late", "update"]) {
            await this.connection.sessionUpdate({
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
            });
          }
          await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "late-call",
              title: "late command",
              kind: "execute",
              status: "pending",
              rawInput: { command: "slidra ls late" },
            },
          });
          const response = await this.connection.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: "late-call", title: "late command", rawInput: { command: "slidra ls late" } },
            options: [
              { kind: "allow_once", name: "Allow", optionId: "allow" },
              { kind: "reject_once", name: "Reject", optionId: "reject" },
            ],
          });
          log({ latePermissionOutcome: response.outcome });
        }, 50);
      }
      return { stopReason };
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params) {
    log({ cancel: params.sessionId });
    this.releaseHold?.();
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
