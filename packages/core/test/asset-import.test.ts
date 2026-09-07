import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  resolveAssetImport,
  resolveConflictFreeFilename,
  resolveDataAssetImport,
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

describe("resolveDataAssetImport — `asset import --as csv` (E2.T14, plan §0(c)/§4.3)", () => {
  const csv = (text: string) => new TextEncoder().encode(text);

  it("C1-style: a legal CSV named *.csv resolves to a conflict-free filename", () => {
    const result = resolveDataAssetImport({
      sourceName: "sales.csv",
      bytes: csv("date,revenue\n2026-01-01,100\n"),
      existingAssetNames: [],
    });
    expect(result.fileName).toBe("sales.csv");
  });

  it("resolves a conflict-free name when the destination already exists (assets/data/'s own sequence)", () => {
    const result = resolveDataAssetImport({
      sourceName: "sales.csv",
      bytes: csv("a\n1\n"),
      existingAssetNames: ["sales.csv"],
    });
    expect(result.fileName).toBe("sales-1.csv");
  });

  it("C8-style: rejects a source whose name is not .csv, unconditionally of content", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "notes.txt", bytes: csv("a\n1\n"), existingAssetNames: [] }),
    ).toThrow(/必須是 \.csv 檔案/);
  });

  it("accepts .CSV case-insensitively", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "SALES.CSV", bytes: csv("a\n1\n"), existingAssetNames: [] }),
    ).not.toThrow();
  });

  it("rejects bytes that are not legal UTF-8", () => {
    const invalidUtf8 = new Uint8Array([0x61, 0xff, 0xfe, 0x62]);
    expect(() =>
      resolveDataAssetImport({ sourceName: "sales.csv", bytes: invalidUtf8, existingAssetNames: [] }),
    ).toThrow(/不是合法的 UTF-8/);
  });

  it("rejects content containing a NUL byte", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "sales.csv", bytes: csv("a\n1\x000\n"), existingAssetNames: [] }),
    ).toThrow(/不是合法的 UTF-8/);
  });

  it("C7: rejects a header containing a reserved dynamic-text name", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "sales.csv", bytes: csv("slide_number,x\n1,2\n"), existingAssetNames: [] }),
    ).toThrow(/保留名稱/);
  });

  it("rejects malformed CSV structure (mismatched column count), reusing table/csv.ts's own validation", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "sales.csv", bytes: csv("a,b\n1\n"), existingAssetNames: [] }),
    ).toThrow(/欄數/);
  });

  it("C8: header-only CSV (zero data rows) is legal", () => {
    expect(() =>
      resolveDataAssetImport({ sourceName: "sales.csv", bytes: csv("a,b\n"), existingAssetNames: [] }),
    ).not.toThrow();
  });
});
