#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

// NOOP-425 D5: the client half of the CLI sandbox. `<sandboxRoot>/bin/slidra`
// (`../src/sandbox/shim-wrapper.ts`) execs this under the exact Node binary
// serve itself runs on, with the agent's own `slidra <args>` argv untouched
// after the script path. Forwards that argv, the real cwd, and stdin to
// `POST /api/agent/exec`, decodes the response's byte-framed stdout/stderr/
// exit-code stream, and writes/exits accordingly — a plain relay, with no
// command or flag whitelist of its own (NOOP-425 §7: "shim 不得引入任何
// 白名單").
//
// Frame shape (matches `shim-endpoint.ts` exactly): every frame starts with
// [1 byte kind][4 bytes big-endian value]. For kind 1 (stdout) and kind 2
// (stderr), that 4-byte value is a payload *length*, followed by that many
// payload bytes. For kind 3 (exit), there is no separate payload at all —
// the 4-byte value *is* the signed exit code, and the frame (and the
// stream) ends there.

import http from "node:http";
import { URL } from "node:url";

const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;
const FRAME_HEADER_BYTES = 5;

function fail(message) {
  process.stderr.write(`slidra-shim: ${message}\n`);
  process.exit(1);
}

const token = process.env.SLIDRA_SHIM_TOKEN;
const baseUrl = process.env.SLIDRA_SHIM_BASE_URL;
if (!token || !baseUrl) {
  fail("SLIDRA_SHIM_TOKEN/SLIDRA_SHIM_BASE_URL are not set — this binary must be run through the sandbox's own PATH");
}

const argv = process.argv.slice(2);
const url = new URL("/api/agent/exec", baseUrl);

const request = http.request(url, {
  method: "POST",
  headers: {
    "x-slidra-shim-token": token,
    "x-slidra-shim-argv": Buffer.from(JSON.stringify(argv), "utf8").toString("base64"),
    "x-slidra-shim-cwd": Buffer.from(process.cwd(), "utf8").toString("base64"),
  },
});

request.on("error", (error) => fail(`request failed: ${error.message}`));

// Most `slidra` commands never read stdin at all, and this process's own
// stdin (inherited from whatever spawned it) is often left open with
// nothing writing to it and nothing closing it — a shell running a
// foreground command with no input redirection behaves exactly this way,
// and a command that never reads it is never affected. `.pipe()` alone
// only flushes the request once it sees data or an explicit end, so an
// idle, never-closing stdin would otherwise leave the request's headers
// unsent forever (reproduced while writing this against a real subprocess
// fixture). `flushHeaders()` sends them immediately regardless of body
// state; the real command's own exit code frame (not this stream's end)
// is what ends the shim's process either way.
request.flushHeaders();
process.stdin.pipe(request);

request.on("response", (response) => {
  if (response.statusCode !== 200) {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => fail(`server refused (${response.statusCode}): ${body}`));
    return;
  }

  let buffered = Buffer.alloc(0);
  let exited = false;

  response.on("data", (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < FRAME_HEADER_BYTES) break;
      const kind = buffered.readUInt8(0);

      if (kind === FRAME_EXIT) {
        const code = buffered.readInt32BE(1);
        exited = true;
        process.exit(code);
      }

      const length = buffered.readUInt32BE(1);
      if (buffered.length < FRAME_HEADER_BYTES + length) break;
      const payload = buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
      buffered = buffered.subarray(FRAME_HEADER_BYTES + length);

      if (kind === FRAME_STDOUT) {
        process.stdout.write(payload);
      } else if (kind === FRAME_STDERR) {
        process.stderr.write(payload);
      }
    }
  });

  response.on("end", () => {
    if (!exited) fail("server closed the connection without an exit frame");
  });
});
