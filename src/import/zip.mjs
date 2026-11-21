// Minimal ZIP reader (stored/deflate, no ZIP64, no encryption).
// Enough for .dshpet (DSH Pet Pack) which is a ZIP with pet.json at the root.
import zlib from "node:zlib";

const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_FILES = 256;

export function readZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("zip buffer required");
  if (buffer.length > MAX_COMPRESSED) throw new Error(`zip too large: ${buffer.length} > ${MAX_COMPRESSED}`);
  const eocd = findEocd(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 is not supported");
  }
  if (total > MAX_FILES) throw new Error(`too many files: ${total}`);

  const files = new Map();
  let expanded = 0;
  let pointer = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("bad central directory");
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.slice(pointer + 46, pointer + 46 + nameLength).toString("utf8");
    assertSafePath(name);
    if (flags & 0x1) throw new Error(`encrypted zip entry: ${name}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 is not supported");
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = zlib.inflateRawSync(compressed);
    else throw new Error(`unsupported zip compression: ${method}`);
    if (content.length !== uncompressedSize) throw new Error(`size mismatch: ${name}`);
    expanded += content.length;
    if (expanded > MAX_EXPANDED) throw new Error("zip expanded size exceeds limit");
    files.set(name, content);
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("not a zip file (no EOCD)");
}

function assertSafePath(name) {
  if (!name || name.startsWith("/") || name.startsWith("\\")) throw new Error(`unsafe zip path: ${name}`);
  if (/^[a-zA-Z]:/.test(name)) throw new Error(`unsafe zip path: ${name}`);
  if (!/^[A-Za-z0-9_./-]+$/.test(name)) throw new Error(`unsafe zip path: ${name}`);
  if (name.split("/").some((part) => part === ".." || part === ".")) throw new Error(`unsafe zip path: ${name}`);
}
