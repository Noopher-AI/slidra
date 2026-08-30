import { inflateSync } from "node:zlib";

/**
 * Minimal PNG pixel reader for `no-background-slide.test.ts`: decodes just
 * enough of the format (non-interlaced, 8-bit RGB/RGBA, the two color
 * types Playwright's own `page.screenshot()` ever emits) to answer "what
 * colour is this pixel", without pulling in an image-decoding dependency
 * for one test file.
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGB at (x, y); throws on out-of-range coordinates. */
  getPixel(x: number, y: number): { r: number; g: number; b: number };
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("decodePng：不是 PNG（signature 不符）");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (interlace !== 0) throw new Error("decodePng：不支援 interlaced PNG");
      if (bitDepth !== 8) throw new Error(`decodePng：不支援 bitDepth=${bitDepth}（只支援 8）`);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length + type(4) + data + crc(4)
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (channels === null) {
    throw new Error(`decodePng：不支援 colorType=${colorType}（只支援 RGB=2、RGBA=6）`);
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rawOffset + i];
      const a = i >= bytesPerPixel ? pixels[rowStart + i - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[prevRowStart + i] : 0;
      const c = y > 0 && i >= bytesPerPixel ? pixels[prevRowStart + i - bytesPerPixel] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + Math.floor((a + b) / 2);
          break;
        case 4:
          value = x + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`decodePng：未知的 filter type ${filterType}`);
      }
      pixels[rowStart + i] = value & 0xff;
    }
    rawOffset += stride;
  }

  return {
    width,
    height,
    getPixel(x: number, y: number) {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new Error(`decodePng.getPixel：座標超出範圍 (${x}, ${y})，圖片大小 ${width}x${height}`);
      }
      const base = y * stride + x * bytesPerPixel;
      return { r: pixels[base], g: pixels[base + 1], b: pixels[base + 2] };
    },
  };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
