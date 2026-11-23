import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";

const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const TABLE_FOOTER_SIZE = 48;
const TABLE_BLOCK_TRAILER_SIZE = 5;
const TABLE_MAGIC_NUMBER = 0xdb4775248b80fb57n;

const VALUE_TYPE_DELETION = 0;
const VALUE_TYPE_VALUE = 1;

const COMPRESSION_NONE = 0;
const COMPRESSION_SNAPPY = 1;
const COMPRESSION_ZSTD = 2;

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

interface PrefixRange {
  start: Uint8Array;
  end: Uint8Array | null;
}

interface LiveTableFile {
  level: number;
  number: bigint;
  smallestUserKey: Uint8Array;
  largestUserKey: Uint8Array;
}

interface VersionedValue {
  seq: bigint;
  type: number;
  value: Uint8Array;
}

function isErrno(error: unknown, ...codes: string[]) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

function isAbortError(error: unknown) {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function nextPrefixBytes(prefix: Uint8Array): Uint8Array | null {
  const next = new Uint8Array(prefix);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 0xff) {
      next[i] += 1;
      return next.subarray(0, i + 1);
    }
  }
  return null;
}

function makePrefixRanges(prefixes: string[]): PrefixRange[] {
  return prefixes.map((prefix) => {
    const start = encoder.encode(prefix);
    return { start, end: nextPrefixBytes(start) };
  });
}

function overlapsAnyPrefix(minKey: Uint8Array | null, maxKey: Uint8Array | null, ranges: PrefixRange[]) {
  for (const { start, end } of ranges) {
    if (maxKey !== null && compareBytes(maxKey, start) < 0) continue;
    if (minKey !== null && end !== null && compareBytes(minKey, end) >= 0) continue;
    return true;
  }
  return false;
}

function matchesAnyPrefix(key: Uint8Array, ranges: PrefixRange[]) {
  return ranges.some(({ start }) => startsWithBytes(key, start));
}

function concatBytes(chunks: Uint8Array[]) {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function readVarint32(buf: Uint8Array, offset: number): [number, number] | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length && shift < 35) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
  return null;
}

function readVarint64(buf: Uint8Array, offset: number): [bigint, number] | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift < 70n) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  return null;
}

function readLengthPrefixedSlice(buf: Uint8Array, offset: number): [Uint8Array, number] | null {
  const lenRes = readVarint32(buf, offset);
  if (!lenRes) return null;
  const [len, start] = lenRes;
  const end = start + len;
  if (end > buf.length) return null;
  return [buf.subarray(start, end), end];
}

function readUint64LE(buf: Uint8Array, offset: number) {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

export function uncompressSnappy(src: Uint8Array): Uint8Array {
  const lenRes = readVarint32(src, 0);
  if (!lenRes) throw new Error("Invalid Snappy stream length.");
  const [uncompressedLength, startPos] = lenRes;
  const out = new Uint8Array(uncompressedLength);

  let pos = startPos;
  let outPos = 0;

  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 0x03;

    if (type === 0) {
      let len = tag >>> 2;
      if (len < 60) {
        len += 1;
      } else {
        const extraBytes = len - 59;
        if (pos + extraBytes > src.length) throw new Error("Truncated Snappy literal length.");
        let value = 0;
        for (let i = 0; i < extraBytes; i++) {
          value |= src[pos++] << (i * 8);
        }
        len = (value >>> 0) + 1;
      }
      if (pos + len > src.length || outPos + len > out.length) {
        throw new Error("Truncated Snappy literal payload.");
      }
      out.set(src.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
      continue;
    }

    let copyLen: number;
    let offset: number;

    if (type === 1) {
      if (pos >= src.length) throw new Error("Truncated Snappy copy-1 offset.");
      copyLen = ((tag >>> 2) & 0x07) + 4;
      offset = ((tag & 0xe0) << 3) | src[pos++];
    } else if (type === 2) {
      if (pos + 2 > src.length) throw new Error("Truncated Snappy copy-2 offset.");
      copyLen = (tag >>> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      if (pos + 4 > src.length) throw new Error("Truncated Snappy copy-4 offset.");
      copyLen = (tag >>> 2) + 1;
      offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      pos += 4;
    }

    if (offset === 0 || offset > outPos || outPos + copyLen > out.length) {
      throw new Error("Invalid Snappy back-reference.");
    }
    for (let i = 0; i < copyLen; i++) {
      out[outPos] = out[outPos - offset];
      outPos++;
    }
  }

  if (outPos !== uncompressedLength) {
    throw new Error("Snappy output size mismatch.");
  }
  return out;
}

function uncompressZstd(src: Uint8Array): Uint8Array | null {
  const maybeZstd = (zlib as { zstdDecompressSync?: (input: Uint8Array) => Buffer }).zstdDecompressSync;
  if (typeof maybeZstd !== "function") return null;
  const out = maybeZstd(src);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function readLogRecords(buf: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let fragments: Uint8Array[] = [];

  for (let blockStart = 0; blockStart < buf.length; blockStart += LOG_BLOCK_SIZE) {
    const blockEnd = Math.min(blockStart + LOG_BLOCK_SIZE, buf.length);
    let pos = blockStart;

    while (pos + LOG_HEADER_SIZE <= blockEnd) {
      const view = new DataView(buf.buffer, buf.byteOffset + pos, LOG_HEADER_SIZE);
      const checksum = view.getUint32(0, true);
      const length = view.getUint16(4, true);
      const type = buf[pos + 6];

      if (type === 0 && length === 0 && checksum === 0) break;
      if (pos + LOG_HEADER_SIZE + length > blockEnd) {
        fragments = [];
        break;
      }

      const payload = buf.subarray(pos + LOG_HEADER_SIZE, pos + LOG_HEADER_SIZE + length);
      pos += LOG_HEADER_SIZE + length;

      if (type === 1) {
        fragments = [];
        records.push(payload);
      } else if (type === 2) {
        fragments = [payload];
      } else if (type === 3) {
        if (fragments.length > 0) fragments.push(payload);
      } else if (type === 4) {
        if (fragments.length > 0) {
          fragments.push(payload);
          records.push(concatBytes(fragments));
          fragments = [];
        }
      } else {
        fragments = [];
      }
    }
  }

  return records;
}

function internalKeyToUserKey(internalKey: Uint8Array) {
  return internalKey.length >= 8 ? internalKey.subarray(0, internalKey.length - 8) : internalKey;
}

function parseManifest(buf: Uint8Array) {
  let logNumber = 0n;
  let prevLogNumber = 0n;
  const liveFiles = new Map<string, LiveTableFile>();

  for (const record of readLogRecords(buf)) {
    let pos = 0;
    while (pos < record.length) {
      const tagRes = readVarint32(record, pos);
      if (!tagRes) break;
      const [tag, nextPos] = tagRes;
      pos = nextPos;

      if (tag === 1) {
        const cmp = readLengthPrefixedSlice(record, pos);
        if (!cmp) break;
        pos = cmp[1];
      } else if (tag === 2) {
        const value = readVarint64(record, pos);
        if (!value) break;
        logNumber = value[0];
        pos = value[1];
      } else if (tag === 3 || tag === 4) {
        const value = readVarint64(record, pos);
        if (!value) break;
        pos = value[1];
      } else if (tag === 5) {
        const level = readVarint32(record, pos);
        if (!level) break;
        const key = readLengthPrefixedSlice(record, level[1]);
        if (!key) break;
        pos = key[1];
      } else if (tag === 6) {
        const level = readVarint32(record, pos);
        if (!level) break;
        const fileNum = readVarint64(record, level[1]);
        if (!fileNum) break;
        liveFiles.delete(`${level[0]}:${fileNum[0]}`);
        pos = fileNum[1];
      } else if (tag === 7) {
        const level = readVarint32(record, pos);
        if (!level) break;
        const fileNum = readVarint64(record, level[1]);
        if (!fileNum) break;
        const fileSize = readVarint64(record, fileNum[1]);
        if (!fileSize) break;
        const smallest = readLengthPrefixedSlice(record, fileSize[1]);
        if (!smallest) break;
        const largest = readLengthPrefixedSlice(record, smallest[1]);
        if (!largest) break;
        liveFiles.set(`${level[0]}:${fileNum[0]}`, {
          level: level[0],
          number: fileNum[0],
          smallestUserKey: internalKeyToUserKey(smallest[0]),
          largestUserKey: internalKeyToUserKey(largest[0]),
        });
        pos = largest[1];
      } else if (tag === 9) {
        const value = readVarint64(record, pos);
        if (!value) break;
        prevLogNumber = value[0];
        pos = value[1];
      } else {
        break;
      }
    }
  }

  return { logNumber, prevLogNumber, liveFiles: [...liveFiles.values()] };
}

function readBlockHandle(buf: Uint8Array, offset: number): [{ offset: number; size: number }, number] | null {
  const offRes = readVarint64(buf, offset);
  if (!offRes) return null;
  const sizeRes = readVarint64(buf, offRes[1]);
  if (!sizeRes) return null;
  return [{ offset: Number(offRes[0]), size: Number(sizeRes[0]) }, sizeRes[1]];
}

function readTableBlock(table: Uint8Array, handle: { offset: number; size: number }): Uint8Array | null {
  if (handle.offset < 0 || handle.size < 0 || handle.offset + handle.size + TABLE_BLOCK_TRAILER_SIZE > table.length) {
    return null;
  }
  const raw = table.subarray(handle.offset, handle.offset + handle.size);
  const compressionType = table[handle.offset + handle.size];

  try {
    if (compressionType === COMPRESSION_NONE) return raw;
    if (compressionType === COMPRESSION_SNAPPY) return uncompressSnappy(raw);
    if (compressionType === COMPRESSION_ZSTD) return uncompressZstd(raw);
    return null;
  } catch {
    return null;
  }
}

function parseBlockEntries(block: Uint8Array): Array<[Uint8Array, Uint8Array]> {
  if (block.length < 4) return [];
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const numRestarts = view.getUint32(block.length - 4, true);
  const limit = block.length - (numRestarts + 1) * 4;
  if (limit < 0 || limit > block.length) return [];

  const entries: Array<[Uint8Array, Uint8Array]> = [];
  let pos = 0;
  let prevKey = new Uint8Array(0);

  while (pos < limit) {
    const sharedRes = readVarint32(block, pos);
    if (!sharedRes) break;
    const unsharedRes = readVarint32(block, sharedRes[1]);
    if (!unsharedRes) break;
    const valueLenRes = readVarint32(block, unsharedRes[1]);
    if (!valueLenRes) break;

    const shared = sharedRes[0];
    const unshared = unsharedRes[0];
    const valueLen = valueLenRes[0];
    pos = valueLenRes[1];

    if (shared > prevKey.length || pos + unshared + valueLen > limit) break;

    const key = new Uint8Array(shared + unshared);
    if (shared > 0) key.set(prevKey.subarray(0, shared), 0);
    if (unshared > 0) key.set(block.subarray(pos, pos + unshared), shared);
    pos += unshared;

    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;

    entries.push([key, value]);
    prevKey = key;
  }

  return entries;
}

function recordVersion(
  versions: Map<string, VersionedValue>,
  userKey: Uint8Array,
  seq: bigint,
  type: number,
  value: Uint8Array,
) {
  const key = decoder.decode(userKey);
  const existing = versions.get(key);
  if (!existing || seq > existing.seq || (seq === existing.seq && type === VALUE_TYPE_DELETION)) {
    versions.set(key, { seq, type, value });
  }
}

function scanSstable(table: Uint8Array, ranges: PrefixRange[], versions: Map<string, VersionedValue>) {
  if (table.length < TABLE_FOOTER_SIZE) return;
  const footerStart = table.length - TABLE_FOOTER_SIZE;
  if (readUint64LE(table, table.length - 8) !== TABLE_MAGIC_NUMBER) return;

  const metaindexRes = readBlockHandle(table, footerStart);
  if (!metaindexRes) return;
  const indexRes = readBlockHandle(table, metaindexRes[1]);
  if (!indexRes) return;

  const indexBlock = readTableBlock(table, indexRes[0]);
  if (!indexBlock) return;

  let prevSepUserKey: Uint8Array | null = null;
  for (const [sepKey, handleBytes] of parseBlockEntries(indexBlock)) {
    const sepUserKey = internalKeyToUserKey(sepKey);
    const shouldRead = overlapsAnyPrefix(prevSepUserKey, sepUserKey, ranges);
    prevSepUserKey = sepUserKey;
    if (!shouldRead) continue;

    const handleRes = readBlockHandle(handleBytes, 0);
    if (!handleRes) continue;
    const dataBlock = readTableBlock(table, handleRes[0]);
    if (!dataBlock) continue;

    for (const [internalKey, value] of parseBlockEntries(dataBlock)) {
      if (internalKey.length < 8) continue;
      const userKey = internalKey.subarray(0, internalKey.length - 8);
      if (!matchesAnyPrefix(userKey, ranges)) continue;
      const tag = readUint64LE(internalKey, internalKey.length - 8);
      const type = Number(tag & 0xffn);
      const seq = tag >> 8n;
      if (type === VALUE_TYPE_VALUE || type === VALUE_TYPE_DELETION) {
        recordVersion(versions, userKey, seq, type, value);
      }
    }
  }
}

function scanWal(buf: Uint8Array, ranges: PrefixRange[], versions: Map<string, VersionedValue>) {
  for (const record of readLogRecords(buf)) {
    if (record.length < 12) continue;
    const baseSeq = readUint64LE(record, 0);
    const count = new DataView(record.buffer, record.byteOffset + 8, 4).getUint32(0, true);
    let pos = 12;

    for (let i = 0; i < count && pos < record.length; i++) {
      const type = record[pos++];
      const seq = baseSeq + BigInt(i);
      if (type === VALUE_TYPE_VALUE) {
        const keyRes = readLengthPrefixedSlice(record, pos);
        if (!keyRes) break;
        const valRes = readLengthPrefixedSlice(record, keyRes[1]);
        if (!valRes) break;
        pos = valRes[1];
        if (matchesAnyPrefix(keyRes[0], ranges)) {
          recordVersion(versions, keyRes[0], seq, VALUE_TYPE_VALUE, valRes[0]);
        }
      } else if (type === VALUE_TYPE_DELETION) {
        const keyRes = readLengthPrefixedSlice(record, pos);
        if (!keyRes) break;
        pos = keyRes[1];
        if (matchesAnyPrefix(keyRes[0], ranges)) {
          recordVersion(versions, keyRes[0], seq, VALUE_TYPE_DELETION, new Uint8Array(0));
        }
      } else {
        break;
      }
    }
  }
}

function formatTableNumber(num: bigint) {
  return num.toString().padStart(6, "0");
}

async function readOptionalBytes(path: string, signal: AbortSignal): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path, { signal });
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function readOnce(
  dir: string,
  ranges: PrefixRange[],
  signal: AbortSignal,
): Promise<{ entries: Map<string, Uint8Array>; missingManifestTable: boolean }> {
  const dirEntries = await readdir(dir, { withFileTypes: true });
  const fileNames = new Set(dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  const versions = new Map<string, VersionedValue>();
  let missingManifestTable = false;

  const currentBytes = fileNames.has("CURRENT") ? await readOptionalBytes(join(dir, "CURRENT"), signal) : null;
  const manifestName = currentBytes ? decoder.decode(currentBytes).trim() : "";
  const manifestBytes =
    manifestName && !manifestName.includes("/") && !manifestName.includes("\\")
      ? await readOptionalBytes(join(dir, manifestName), signal)
      : null;

  if (manifestBytes) {
    const manifest = parseManifest(manifestBytes);

    for (const file of manifest.liveFiles) {
      if (!overlapsAnyPrefix(file.smallestUserKey, file.largestUserKey, ranges)) continue;
      const stem = formatTableNumber(file.number);
      const tableBytes =
        (await readOptionalBytes(join(dir, `${stem}.ldb`), signal)) ??
        (await readOptionalBytes(join(dir, `${stem}.sst`), signal));
      if (!tableBytes) {
        missingManifestTable = true;
        continue;
      }
      scanSstable(tableBytes, ranges, versions);
    }

    const logFiles = [...fileNames]
      .filter((name) => /^\d+\.log$/.test(name))
      .map((name) => ({ name, number: BigInt(name.slice(0, -4)) }))
      .filter(({ number }) => number >= manifest.logNumber || number === manifest.prevLogNumber)
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

    for (const { name } of logFiles) {
      const logBytes = await readOptionalBytes(join(dir, name), signal);
      if (logBytes) scanWal(logBytes, ranges, versions);
    }
  } else {
    const tableFiles = [...fileNames].filter((name) => /^\d+\.(ldb|sst)$/.test(name)).sort();
    for (const name of tableFiles) {
      const tableBytes = await readOptionalBytes(join(dir, name), signal);
      if (tableBytes) scanSstable(tableBytes, ranges, versions);
    }
    const logFiles = [...fileNames].filter((name) => /^\d+\.log$/.test(name)).sort();
    for (const name of logFiles) {
      const logBytes = await readOptionalBytes(join(dir, name), signal);
      if (logBytes) scanWal(logBytes, ranges, versions);
    }
  }

  const entries = new Map<string, Uint8Array>();
  for (const [key, entry] of versions) {
    if (entry.type === VALUE_TYPE_VALUE) {
      entries.set(key, entry.value);
    }
  }

  return { entries, missingManifestTable };
}

export async function readLevelDbPrefixes(
  dir: string,
  prefixes: string[],
  signal: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  if (!prefixes.length) return new Map();
  const ranges = makePrefixRanges(prefixes);

  try {
    const first = await readOnce(dir, ranges, signal);
    if (!first.missingManifestTable) return first.entries;
    const retry = await readOnce(dir, ranges, signal);
    return retry.entries;
  } catch (error) {
    if (isAbortError(error) || isErrno(error, "EPERM", "EACCES")) throw error;
    if (isErrno(error, "ENOENT", "ENOTDIR")) return new Map();
    throw error;
  }
}
