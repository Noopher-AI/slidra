import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A genuine EPIPE (a downstream pipe closing early, e.g. `co-motion cat id
// path | head`) can only be provoked through a real OS pipe between two
// real processes — there is no way to reproduce it by dispatching through
// the in-process registry. This file spawns the actual `co-motion` bin, so
// it needs the compiled dist to exist; build once here so the test is
// self-sufficient even right after `rm -rf packages/*/dist`.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "../../..");
const binPath = path.join(rootDir, "packages/cli/bin/co-motion.js");
const tscPath = path.join(rootDir, "node_modules/.bin/tsc");

let coMotionHome: string;
let comotDir: string;

beforeAll(() => {
  execFileSync(tscPath, ["-b"], { cwd: rootDir, stdio: "ignore" });
}, 60_000);

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
});

afterEach(async () => {
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("a downstream pipe that closes early", () => {
  it(
    "exits cleanly instead of crashing with an unhandled EPIPE",
    async () => {
      // A small write can complete before the reader ever closes the pipe,
      // so this needs enough bytes that stdout.write() is still pushing
      // data through the kernel pipe buffer after `head -c 1` reads its one
      // byte and exits.
      const bigContent = "x".repeat(8 * 1024 * 1024);
      const zipped = zipSync({
        "project.json": new TextEncoder().encode(
          JSON.stringify({ formatVersion: 1, name: "epipe test", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
        ),
        "slides/001.svg": new TextEncoder().encode("<svg></svg>"),
        "assets/big.txt": new TextEncoder().encode(bigContent),
      });
      const comotPath = path.join(comotDir, "big.comot");
      await writeFile(comotPath, zipped);

      const env = { ...process.env, CO_MOTION_HOME: coMotionHome };
      const openOutput = execFileSync("node", [binPath, "open", comotPath], { env, encoding: "utf-8" });
      const idMatch = openOutput.match(/識別碼：(\S+)/);
      expect(idMatch).not.toBeNull();
      const id = idMatch![1];

      const { code, stderr } = await runCatPipedThroughHead(id, env);

      // An unhandled EPIPE crash prints a Node stack trace on stderr and,
      // with `set -o pipefail`, makes the whole pipeline exit non-zero
      // because `node` itself exited non-zero — even though `head` alone
      // would report success.
      expect(stderr).not.toContain("EPIPE");
      expect(stderr).not.toContain("Error: write");
      expect(code).toBe(0);
    },
    20_000,
  );
});

function runCatPipedThroughHead(
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const shellCommand = `set -o pipefail; node ${JSON.stringify(binPath)} cat ${JSON.stringify(
      id,
    )} assets/big.txt | head -c 1 >/dev/null`;
    const child = spawn("bash", ["-c", shellCommand], { env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
