import { join } from "node:path";
import { readLevelDbPrefixes } from "./leveldb.ts";

const LOCAL_PREFIX = "reading_list-dt-";
const ACCOUNT_PREFIX = "A-reading_list-dt-";
const READING_LIST_PREFIXES = [ACCOUNT_PREFIX, LOCAL_PREFIX];

const STATUS_READ = 1;
const STATUS_UNSEEN = 2;

const decoder = new TextDecoder("utf-8", { fatal: false });

export interface DecodedReadingListEntry {
  entryId?: string;
  title?: string;
  url?: string;
  creationTimeUs: bigint;
  updateTimeUs: bigint;
  read: boolean;
}

export interface ReadingListItem {
  title: string;
  url: string;
  read: boolean;
  sortTimeUs: bigint;
}

function readVarint(buf: Uint8Array, offset: number): [bigint, number] | null {
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

export function decodeReadingListLocal(bytes: Uint8Array): DecodedReadingListEntry | null {
  let entryId: string | undefined;
  let title: string | undefined;
  let url: string | undefined;
  let creationTimeUs = 0n;
  let updateTimeUs = 0n;
  let status = STATUS_UNSEEN;

  let pos = 0;
  while (pos < bytes.length) {
    const tagRes = readVarint(bytes, pos);
    if (!tagRes) return null;
    const [tag, nextPos] = tagRes;
    pos = nextPos;

    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);

    if (wireType === 0) {
      const valRes = readVarint(bytes, pos);
      if (!valRes) return null;
      const [val, afterVal] = valRes;
      pos = afterVal;

      if (fieldNumber === 4) creationTimeUs = val;
      else if (fieldNumber === 5) updateTimeUs = val;
      else if (fieldNumber === 6) status = Number(val);
    } else if (wireType === 1) {
      if (pos + 8 > bytes.length) return null;
      pos += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(bytes, pos);
      if (!lenRes) return null;
      const len = Number(lenRes[0]);
      const start = lenRes[1];
      const end = start + len;
      if (len < 0 || end > bytes.length) return null;
      const slice = bytes.subarray(start, end);
      pos = end;

      if (fieldNumber === 1) entryId = decoder.decode(slice);
      else if (fieldNumber === 2) title = decoder.decode(slice);
      else if (fieldNumber === 3) url = decoder.decode(slice);
    } else if (wireType === 5) {
      if (pos + 4 > bytes.length) return null;
      pos += 4;
    } else {
      return null;
    }
  }

  return {
    entryId,
    title,
    url,
    creationTimeUs,
    updateTimeUs,
    read: status === STATUS_READ,
  };
}

function stripPrefix(key: string): { isAccount: boolean; keyUrl: string } | null {
  if (key.startsWith(ACCOUNT_PREFIX)) {
    return { isAccount: true, keyUrl: key.slice(ACCOUNT_PREFIX.length) };
  }
  if (key.startsWith(LOCAL_PREFIX)) {
    return { isAccount: false, keyUrl: key.slice(LOCAL_PREFIX.length) };
  }
  return null;
}

export async function readProfileReadingList(profileDir: string, signal: AbortSignal): Promise<ReadingListItem[]> {
  const levelDbDir = join(profileDir, "Sync Data", "LevelDB");
  const records = await readLevelDbPrefixes(levelDbDir, READING_LIST_PREFIXES, signal);

  const byUrl = new Map<string, ReadingListItem & { isAccount: boolean }>();

  for (const [key, bytes] of records) {
    const meta = stripPrefix(key);
    if (!meta) continue;

    const decoded = decodeReadingListLocal(bytes);
    if (!decoded) continue;

    const url = (decoded.url || decoded.entryId || meta.keyUrl).trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;

    const title = decoded.title?.trim() || url;
    const sortTimeUs = decoded.updateTimeUs > 0n ? decoded.updateTimeUs : decoded.creationTimeUs;

    const existing = byUrl.get(url);
    if (
      !existing ||
      sortTimeUs > existing.sortTimeUs ||
      (sortTimeUs === existing.sortTimeUs && meta.isAccount && !existing.isAccount)
    ) {
      byUrl.set(url, { title, url, read: decoded.read, sortTimeUs, isAccount: meta.isAccount });
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      if (a.sortTimeUs !== b.sortTimeUs) return a.sortTimeUs > b.sortTimeUs ? -1 : 1;
      return a.title.localeCompare(b.title);
    })
    .map(({ title, url, read, sortTimeUs }) => ({ title, url, read, sortTimeUs }));
}
