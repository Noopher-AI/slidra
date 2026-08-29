import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectMediaFormat } from "../src/media-format.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/\s+/g, ""), "hex"));
}

/** Builds a minimal, structurally real ISO-BMFF "ftyp" box: size, "ftyp", major brand, minor version. */
function isoBmff(majorBrand: string): Uint8Array {
  const box = Buffer.alloc(16);
  box.writeUInt32BE(16, 0);
  box.write("ftyp", 4, "ascii");
  box.write(majorBrand, 8, "ascii");
  box.writeUInt32BE(0, 12);
  return Uint8Array.from(box);
}

describe("detectMediaFormat", () => {
  it("recognises a PNG by its 8-byte signature", () => {
    const format = detectMediaFormat(bytesOf("89504e470d0a1a0a0000000d49484452"));
    expect(format?.extension).toBe(".png");
    expect(format?.mimeType).toBe("image/png");
    expect(format?.kind).toBe("image");
  });

  it("recognises a JPEG by its SOI + APP marker", () => {
    const format = detectMediaFormat(bytesOf("ffd8ffe000104a464946"));
    expect(format?.extension).toBe(".jpg");
  });

  it("recognises a GIF by its GIF8 signature", () => {
    const format = detectMediaFormat(bytesOf("474946383961"));
    expect(format?.extension).toBe(".gif");
  });

  it("recognises a WEBP by its RIFF....WEBP header", () => {
    const riff = Buffer.alloc(16);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(8, 4);
    riff.write("WEBP", 8, "ascii");
    const format = detectMediaFormat(Uint8Array.from(riff));
    expect(format?.extension).toBe(".webp");
  });

  it("recognises a WAV by its RIFF....WAVE header", () => {
    const riff = Buffer.alloc(16);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(8, 4);
    riff.write("WAVE", 8, "ascii");
    const format = detectMediaFormat(Uint8Array.from(riff));
    expect(format?.extension).toBe(".wav");
  });

  it("does not confuse an unrecognised RIFF fourCC with WEBP/WAV", () => {
    const riff = Buffer.alloc(16);
    riff.write("RIFF", 0, "ascii");
    riff.writeUInt32LE(8, 4);
    riff.write("AVI ", 8, "ascii");
    expect(detectMediaFormat(Uint8Array.from(riff))).toBeNull();
  });

  it("recognises a generic MP4 ISO-BMFF brand", () => {
    expect(detectMediaFormat(isoBmff("isom"))?.extension).toBe(".mp4");
  });

  it("recognises the QuickTime major brand as .mov", () => {
    expect(detectMediaFormat(isoBmff("qt  "))?.extension).toBe(".mov");
  });

  it("recognises the M4A major brand as audio", () => {
    const format = detectMediaFormat(isoBmff("M4A "));
    expect(format?.extension).toBe(".m4a");
    expect(format?.kind).toBe("audio");
  });

  it("recognises the M4V major brand", () => {
    expect(detectMediaFormat(isoBmff("M4V "))?.extension).toBe(".m4v");
  });

  it("recognises a WEBM by its EBML signature", () => {
    const format = detectMediaFormat(bytesOf("1a45dfa3"));
    expect(format?.extension).toBe(".webm");
  });

  it("recognises an MP3 by an ID3 tag", () => {
    const format = detectMediaFormat(bytesOf("4944330300000000"));
    expect(format?.extension).toBe(".mp3");
  });

  it("recognises a raw MPEG frame sync (layer III) as MP3", () => {
    // 11111111 11111011: sync + MPEG1 + Layer III + no CRC.
    const format = detectMediaFormat(bytesOf("fffb900000"));
    expect(format?.extension).toBe(".mp3");
  });

  it("recognises a raw ADTS AAC frame sync (reserved layer bits) as AAC", () => {
    // 11111111 11110001: sync + reserved layer bits ADTS repurposes.
    const format = detectMediaFormat(bytesOf("fff1500000"));
    expect(format?.extension).toBe(".aac");
  });

  it("recognises a real Ogg/Vorbis fixture as .oga", async () => {
    const bytes = await readFile(path.join(repoRoot, "e2e/fixtures/media-deck/assets/narration.oga"));
    expect(detectMediaFormat(Uint8Array.from(bytes))?.extension).toBe(".oga");
  });

  it("recognises a real WebM fixture as .webm", async () => {
    const bytes = await readFile(path.join(repoRoot, "e2e/fixtures/media-deck/assets/clip.webm"));
    expect(detectMediaFormat(Uint8Array.from(bytes))?.extension).toBe(".webm");
  });

  it("rejects an Ogg stream whose codec identification header is unrecognised", () => {
    const oggS = Buffer.alloc(64);
    oggS.write("OggS", 0, "ascii");
    expect(detectMediaFormat(Uint8Array.from(oggS))).toBeNull();
  });

  it("rejects plain text content — no signature matches", () => {
    expect(detectMediaFormat(new TextEncoder().encode("this is just a text file"))).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(detectMediaFormat(new Uint8Array(0))).toBeNull();
  });
});
