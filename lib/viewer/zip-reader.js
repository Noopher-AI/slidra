// A minimal, read-only ZIP reader for legacy `.slidra` decks
// (`formatVersion` 1 through 4 were ZIP archives — spec §1). Supports the
// two methods any real deck uses: stored (0) and deflate (8), the latter via
// the platform's own `DecompressionStream("deflate-raw")`.

export class ZipFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Default resource limits (format §17); a reader may pass tighter ones. */
export const ZIP_LIMITS = Object.freeze({ maxEntries: 50_000, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 });

/**
 * Reads every entry of the archive into memory. A damaged or hostile archive
 * fails with a ZipFormatError; an entry is checked against the limits by its
 * declared size before it is inflated, and inflating stops at that size.
 * @param {Uint8Array} bytes
 * @param {{ maxEntries: number, maxEntryBytes: number, maxTotalBytes: number }} [limits]
 * @returns {Promise<Map<string, Uint8Array | null>>} path -> bytes (`null` for a directory entry, whose path keeps no trailing slash)
 */
export async function readZip(bytes, limits = ZIP_LIMITS) {
  try {
    return await readEntries(bytes, limits);
  } catch (error) {
    if (error instanceof ZipFormatError) throw error;
    throw new ZipFormatError(`the archive is malformed (${error instanceof Error ? error.message || error.name : String(error)})`);
  }
}

async function readEntries(bytes, limits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > limits.maxEntries) throw new ZipFormatError(`the archive has ${entryCount} entries, more than the limit of ${limits.maxEntries}`);
  let total = 0;
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const entries = new Map();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new ZipFormatError("corrupt central directory");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > bytes.length) throw new ZipFormatError("an entry name runs past the end of the archive");
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new ZipFormatError(`entry "${name}" is encrypted`);
    if (name.endsWith("/")) {
      entries.set(name.slice(0, -1), null);
      continue;
    }

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new ZipFormatError(`corrupt local header for "${name}"`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) throw new ZipFormatError(`entry "${name}" runs past the end of the archive`);
    if (size > limits.maxEntryBytes) throw new ZipFormatError(`entry "${name}" is ${size} bytes, more than the limit of ${limits.maxEntryBytes}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipFormatError(`the archive inflates to more than the limit of ${limits.maxTotalBytes} bytes`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw, size);
    else throw new ZipFormatError(`entry "${name}" uses unsupported compression method ${method}`);
    if (data.length !== size) throw new ZipFormatError(`entry "${name}" decompressed to the wrong size`);
    entries.set(name, data);
  }
  return entries;
}

function findEndOfCentralDirectory(bytes, view) {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= minimum; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new ZipFormatError("end of central directory not found");
}

/** Inflates `raw`, refusing to produce more than `size` bytes (a zip bomb stops at its declared size). */
async function inflateRaw(raw, size) {
  if (typeof DecompressionStream !== "function") {
    throw new ZipFormatError("this browser cannot decompress ZIP entries (DecompressionStream is missing)");
  }
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const out = new Uint8Array(size);
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (written + value.length > size) throw new ZipFormatError(`an entry inflates beyond its declared size of ${size} bytes`);
      out.set(value, written);
      written += value.length;
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ZipFormatError) throw error;
    throw new ZipFormatError("an entry's compressed data is corrupt");
  }
  return written === size ? out : out.subarray(0, written);
}
