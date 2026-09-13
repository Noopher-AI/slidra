// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentationInfoLoader, fetchPresentationInfo } from "../src/presentation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPresentationInfo", () => {
  it("returns the presentation's name and canvas size on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ formatVersion: 1, name: "Acceptance Demo Deck", canvas: { width: 1280, height: 720 }, slides: [] }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "Acceptance Demo Deck",
      canvas: { width: 1280, height: 720 },
      templates: [],
    });
  });

  it("normalizes bare-string templates[] into { file, name } using the basename (A11)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            formatVersion: 1,
            name: "Deck with templates",
            canvas: { width: 1280, height: 720 },
            templates: ["templates/001.svg", "templates/002.svg"],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "Deck with templates",
      canvas: { width: 1280, height: 720 },
      templates: [
        { file: "templates/001.svg", name: "001" },
        { file: "templates/002.svg", name: "002" },
      ],
    });
  });

  it("carries the name through from post-upgrade { file, name } template entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            formatVersion: 2,
            name: "Object-format templates",
            canvas: { width: 1280, height: 720 },
            templates: [
              { file: "templates/001.svg", name: "Cover" },
              { file: "templates/002.svg", name: "Section page" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "Object-format templates",
      canvas: { width: 1280, height: 720 },
      templates: [
        { file: "templates/001.svg", name: "Cover" },
        { file: "templates/002.svg", name: "Section page" },
      ],
    });
  });

  it("normalizes a mix of pre- and post-upgrade template entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            formatVersion: 2,
            name: "Mixed-format templates",
            canvas: { width: 1280, height: 720 },
            templates: ["templates/001.svg", { file: "templates/002.svg", name: "Section page" }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "Mixed-format templates",
      canvas: { width: 1280, height: 720 },
      templates: [
        { file: "templates/001.svg", name: "001" },
        { file: "templates/002.svg", name: "Section page" },
      ],
    });
  });

  it("falls back to the basename when a { file } entry's name isn't a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            formatVersion: 2,
            name: "name field has the wrong type",
            canvas: { width: 1280, height: 720 },
            templates: [{ file: "templates/001.svg", name: 42 }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "name field has the wrong type",
      canvas: { width: 1280, height: 720 },
      templates: [{ file: "templates/001.svg", name: "001" }],
    });
  });

  it("falls back to templates: [] when the field is present but not a string array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            formatVersion: 1,
            name: "malformed templates field",
            canvas: { width: 1280, height: 720 },
            templates: [1, 2],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "malformed templates field",
      canvas: { width: 1280, height: 720 },
      templates: [],
    });
  });

  it("throws on a non-2xx response, rather than returning a fabricated default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchPresentationInfo()).rejects.toThrow("Failed to load: /api/presentation");
  });

  it("throws when the canvas size is invalid, rather than falling back to a made-up size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ formatVersion: 1, name: "test", canvas: { width: 0, height: 720 } }), {
          status: 200,
        }),
      ),
    );

    await expect(fetchPresentationInfo()).rejects.toThrow("canvas size is invalid");
  });
});

describe("createPresentationInfoLoader", () => {
  // Same race this file's own overview.ts precedent (aspectGeneration)
  // guards against: two overlapping load() calls — e.g. two rapid
  // live-reload presentation-changed events — must not let an older,
  // slower response (success or failure) settle after a newer one and
  // overwrite it with stale or outright wrong titlebar metadata.

  it("a newer load()'s success always wins over an older one still in flight, regardless of resolve order", async () => {
    let resolveOlder!: (response: Response) => void;
    const olderPromise = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        // The first load() call's fetch is held open; the second resolves
        // immediately, so it settles and applies first.
        return callCount === 1
          ? olderPromise
          : new Response(
              JSON.stringify({ formatVersion: 1, name: "newer", canvas: { width: 1280, height: 720 } }),
              { status: 200 },
            );
      }),
    );

    const onSuccess = vi.fn();
    const onError = vi.fn();
    const loader = createPresentationInfoLoader({ onSuccess, onError });

    loader.load(); // older, held open
    loader.load(); // newer, resolves immediately
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ name: "newer", canvas: { width: 1280, height: 720 }, templates: [] });

    // The older, slower fetch now resolves. Its result must be discarded —
    // it must not overwrite what the newer call already applied.
    resolveOlder(
      new Response(JSON.stringify({ formatVersion: 1, name: "older", canvas: { width: 1280, height: 720 } }), {
        status: 200,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("an older load()'s failure settling after a newer success must not clear the correct metadata with an error banner", async () => {
    let rejectOlder!: (error: Error) => void;
    const olderPromise = new Promise<Response>((_resolve, reject) => {
      rejectOlder = reject;
    });
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        return callCount === 1
          ? olderPromise
          : new Response(
              JSON.stringify({ formatVersion: 1, name: "correct data", canvas: { width: 1280, height: 720 } }),
              { status: 200 },
            );
      }),
    );

    const onSuccess = vi.fn();
    const onError = vi.fn();
    const loader = createPresentationInfoLoader({ onSuccess, onError });

    loader.load(); // older, will reject late
    loader.load(); // newer, resolves immediately with the correct data
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSuccess).toHaveBeenCalledWith({ name: "correct data", canvas: { width: 1280, height: 720 }, templates: [] });

    // The older call's fetch now rejects. A stale failure must never fire
    // onError after a newer success has already landed — that would show
    // an error banner over metadata that is, in fact, correct.
    rejectOlder(new Error("older request failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
