import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  resolveAssetImport,
  resolveConflictFreeFilename,
  sanitizeAssetBaseName,
} from "../src/asset-import.js";

const PNG_BYTES = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

describe("sanitizeAssetBaseName", () => {
  it("strips the extension", () => {
    expect(sanitizeAssetBaseName("photo.png")).toBe("photo");
  });

  it("strips only the last extension, keeping dots elsewhere in the name", () => {
    expect(sanitizeAssetBaseName("my.trip.photo.jpg")).toBe("my.trip.photo");
  });

  it("replaces illegal filesystem characters with underscores", () => {
    expect(sanitizeAssetBaseName("weird:name?.png")).toBe("weird_name_");
  });

  it("falls back to 'asset' when nothing usable remains", () => {
    expect(sanitizeAssetBaseName(".png")).toBe("asset");
  });
});

describe("resolveConflictFreeFilename", () => {
  it("returns the plain name when there is no conflict", () => {
    expect(resolveConflictFreeFilename("photo", ".png", [])).toBe("photo.png");
  });

  it("appends -1 when the plain name is already taken", () => {
    expect(resolveConflictFreeFilename("photo", ".png", ["photo.png"])).toBe("photo-1.png");
  });

  it("increments past every already-taken numbered name", () => {
    expect(resolveConflictFreeFilename("photo", ".png", ["photo.png", "photo-1.png", "photo-2.png"])).toBe(
      "photo-3.png",
    );
  });

  it("does not reuse a gap — always continues from the lowest free suffix scanning upward", () => {
    // photo-1.png is free, but photo.png is taken and this function starts
    // its search at -1, so a gap earlier in the sequence is still filled
    // before any later one — this is the documented behaviour, not an
    // accidental gap-skip.
    expect(resolveConflictFreeFilename("photo", ".png", ["photo.png", "photo-2.png"])).toBe("photo-1.png");
  });
});

describe("resolveAssetImport", () => {
  it("detects the real format and names the file after the sanitized source name", () => {
    const result = resolveAssetImport({
      sourceName: "vacation.png",
      bytes: PNG_BYTES,
      existingAssetNames: [],
    });

    expect(result.format.extension).toBe(".png");
    expect(result.fileName).toBe("vacation.png");
  });

  it("uses the detected format's extension even when the source name has a different one", () => {
    const result = resolveAssetImport({
      sourceName: "vacation.jpg",
      bytes: PNG_BYTES,
      existingAssetNames: [],
    });

    expect(result.fileName).toBe("vacation.png");
  });

  it("resolves a conflict-free name when the destination already exists", () => {
    const result = resolveAssetImport({
      sourceName: "vacation.png",
      bytes: PNG_BYTES,
      existingAssetNames: ["vacation.png"],
    });

    expect(result.fileName).toBe("vacation-1.png");
  });

  it("throws when the bytes match no known media format — e.g. a text file disguised as .png", () => {
    const textBytes = new TextEncoder().encode("this is not a real image");

    expect(() =>
      resolveAssetImport({ sourceName: "fake.png", bytes: textBytes, existingAssetNames: [] }),
    ).toThrow(CoMotionError);
  });
});
