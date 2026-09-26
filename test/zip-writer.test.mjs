import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, zipStore } from "../lib/viewer/zip-writer.js";
import { readZip } from "../lib/viewer/zip-reader.js";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("a stored archive reads back with this repo's reader", async () => {
  const files = [
    { name: "Talk-slide-01.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
    { name: "簡報-slide-02.png", data: new Uint8Array(70_000).map((_, i) => i % 251) },
  ];
  const entries = await readZip(zipStore(files));
  assert.deepEqual(
    [...entries.keys()],
    files.map((f) => f.name),
  );
  for (const f of files) assert.deepEqual(entries.get(f.name), f.data);
});

test("the system unzip accepts it too", { skip: !hasUnzip() && "no unzip on this system" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-zip-"));
  const file = path.join(dir, "slides.zip");
  writeFileSync(file, zipStore([{ name: "a.png", data: new Uint8Array([1, 2, 3]) }]));
  assert.match(execFileSync("unzip", ["-t", file], { encoding: "utf8" }), /No errors detected/);
});

function hasUnzip() {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
