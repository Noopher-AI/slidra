import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { GET } from "../app/api/decks/route.js";

test("/api/decks lists the served decks and says whether they may load network resources", async () => {
  const previous = { decks: process.env.SLIDRA_DECKS, remote: process.env.SLIDRA_ALLOW_REMOTE };
  try {
    process.env.SLIDRA_DECKS = "examples";
    delete process.env.SLIDRA_ALLOW_REMOTE;
    const body = await (await GET()).json();
    const onDisk = readdirSync(new URL("../examples/", import.meta.url))
      .filter((file) => file.endsWith(".slidra"))
      .sort();
    assert.deepEqual(body.decks.map((d) => d.name).sort(), onDisk);
    assert.ok(onDisk.includes("motion.slidra") && onDisk.includes("sharing.slidra"));
    assert.equal(body.allowRemote, false);
    process.env.SLIDRA_ALLOW_REMOTE = "1";
    assert.equal((await (await GET()).json()).allowRemote, true);
  } finally {
    for (const [key, value] of [
      ["SLIDRA_DECKS", previous.decks],
      ["SLIDRA_ALLOW_REMOTE", previous.remote],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
