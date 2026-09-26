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

/**
 * Reads every entry of the archive into memory.
 * @returns {Promise<Map<string, Uint8Array | null>>} path -> bytes (`null` for a directory entry, whose path keeps no trailing slash)
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(eocd + 10, true);
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
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
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

async function inflateRaw(raw) {
  if (typeof DecompressionStream !== "function") {
    throw new ZipFormatError("this browser cannot decompress ZIP entries (DecompressionStream is missing)");
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
