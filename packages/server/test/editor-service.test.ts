// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEditorService, type EditorService } from "../src/editor-service.js";

let root: string;
let service: EditorService | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "slidra-editor-service-"));
  await mkdir(path.join(root, "_next"), { recursive: true });
  await writeFile(path.join(root, "_next", "app.js"), "compiled editor");
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("editor service", () => {
  it("serves prebuilt page bytes and static assets, but no API", async () => {
    const indexHtml = new TextEncoder().encode(
      '<html><script id="slidra-bootstrap" type="application/json">{"workbenchId":"wb-1"}</script></html>',
    );
    service = await startEditorService({ port: 0, staticDir: root, indexHtml });

    const page = await fetch(`${service.url}/`);
    expect(page.status).toBe(200);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(indexHtml);

    const asset = await fetch(`${service.url}/_next/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("compiled editor");

    expect((await fetch(`${service.url}/api/presentation`)).status).toBe(404);
    expect((await fetch(`${service.url}/api/chat`)).status).toBe(404);
  });
});
