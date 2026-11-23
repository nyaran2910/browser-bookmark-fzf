import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import { readBookmarks } from "./browser.ts";
import { readLevelDbPrefixes, readLogRecords, uncompressSnappy } from "./leveldb.ts";
import { decodeReadingListLocal } from "./reading-list.ts";

const enc = new TextEncoder();

function encodeVarint32(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function encodeVarint64(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

function uint64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concat(encodeVarint32(bytes.length), bytes);
}

function makeInternalKey(userKey: string, seq: bigint, type: 0 | 1): Uint8Array {
  const tag = (seq << 8n) | BigInt(type);
  return concat(enc.encode(userKey), uint64LE(tag));
}

function makeLogFile(records: Uint8Array[]): Uint8Array {
  const BLOCK_SIZE = 32768;
  const HEADER_SIZE = 7;
  const chunks: Uint8Array[] = [];
  let blockOffset = 0;

  for (const record of records) {
    let pos = 0;
    let first = true;
    do {
      const leftover = BLOCK_SIZE - blockOffset;
      if (leftover < HEADER_SIZE) {
        if (leftover > 0) chunks.push(new Uint8Array(leftover));
        blockOffset = 0;
      }
      const avail = BLOCK_SIZE - blockOffset - HEADER_SIZE;
      const fragLen = Math.min(record.length - pos, avail);
      const end = pos + fragLen === record.length;
      const type = first && end ? 1 : first ? 2 : end ? 4 : 3;

      const header = new Uint8Array(HEADER_SIZE);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0, true);
      view.setUint16(4, fragLen, true);
      header[6] = type;

      chunks.push(header, record.subarray(pos, pos + fragLen));
      blockOffset += HEADER_SIZE + fragLen;
      pos += fragLen;
      first = false;
    } while (pos < record.length);
  }

  return concat(...chunks);
}

function makeWriteBatch(baseSeq: bigint, ops: Array<{ type: 0 | 1; key: string; value?: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [uint64LE(baseSeq), uint32LE(ops.length)];
  for (const op of ops) {
    parts.push(new Uint8Array([op.type]), lengthPrefixed(enc.encode(op.key)));
    if (op.type === 1) {
      parts.push(lengthPrefixed(op.value ?? new Uint8Array(0)));
    }
  }
  return concat(...parts);
}

function encodeBlock(entries: Array<[Uint8Array, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [];
  const restarts: number[] = [];
  let offset = 0;
  let prevKey = new Uint8Array(0);

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    let shared = 0;
    if (i % 2 === 0) {
      restarts.push(offset);
    } else {
      const maxShared = Math.min(prevKey.length, key.length);
      while (shared < maxShared && prevKey[shared] === key[shared]) shared++;
    }
    const unshared = key.length - shared;
    const entry = concat(
      encodeVarint32(shared),
      encodeVarint32(unshared),
      encodeVarint32(value.length),
      key.subarray(shared),
      value,
    );
    parts.push(entry);
    offset += entry.length;
    prevKey = key;
  }

  for (const r of restarts) parts.push(uint32LE(r));
  parts.push(uint32LE(restarts.length));
  return concat(...parts);
}

function snappyLiteralOnly(input: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [encodeVarint32(input.length)];
  let pos = 0;
  while (pos < input.length) {
    const chunkLen = Math.min(input.length - pos, 256);
    if (chunkLen <= 60) {
      parts.push(new Uint8Array([(chunkLen - 1) << 2]), input.subarray(pos, pos + chunkLen));
    } else {
      parts.push(new Uint8Array([(60 << 2) | 0, chunkLen - 1]), input.subarray(pos, pos + chunkLen));
    }
    pos += chunkLen;
  }
  return concat(...parts);
}

function makeSstable(
  blocks: Array<Array<[Uint8Array, Uint8Array]>>,
  compression: 0 | 1 | 2 = 0,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const indexEntries: Array<[Uint8Array, Uint8Array]> = [];
  let offset = 0;

  for (const entries of blocks) {
    const rawBlock = encodeBlock(entries);
    const payload =
      compression === 0
        ? rawBlock
        : compression === 1
          ? snappyLiteralOnly(rawBlock)
          : new Uint8Array(zlib.zstdCompressSync(rawBlock));
    const handle = concat(encodeVarint64(BigInt(offset)), encodeVarint64(BigInt(payload.length)));
    const lastKey = entries[entries.length - 1][0];
    indexEntries.push([lastKey, handle]);

    parts.push(payload, new Uint8Array([compression, 0, 0, 0, 0]));
    offset += payload.length + 5;
  }

  const metaBlock = encodeBlock([]);
  const metaHandle = concat(encodeVarint64(BigInt(offset)), encodeVarint64(BigInt(metaBlock.length)));
  parts.push(metaBlock, new Uint8Array([0, 0, 0, 0, 0]));
  offset += metaBlock.length + 5;

  const indexBlock = encodeBlock(indexEntries);
  const indexHandle = concat(encodeVarint64(BigInt(offset)), encodeVarint64(BigInt(indexBlock.length)));
  parts.push(indexBlock, new Uint8Array([0, 0, 0, 0, 0]));

  const footer = new Uint8Array(48);
  const handles = concat(metaHandle, indexHandle);
  footer.set(handles, 0);
  footer.set(uint64LE(0xdb4775248b80fb57n), 40);
  parts.push(footer);

  return concat(...parts);
}

function encodeReadingListProto(fields: {
  entryId?: string;
  title?: string;
  url?: string;
  creationTimeUs?: bigint;
  updateTimeUs?: bigint;
  status?: number;
  distillationState?: number;
  distilledPath?: string;
  estimatedReadTimeSeconds?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const str = (field: number, value?: string) => {
    if (value === undefined) return;
    const bytes = enc.encode(value);
    parts.push(encodeVarint32((field << 3) | 2), encodeVarint32(bytes.length), bytes);
  };
  const varint = (field: number, value?: bigint | number) => {
    if (value === undefined) return;
    parts.push(encodeVarint32((field << 3) | 0), encodeVarint64(BigInt(value)));
  };

  str(1, fields.entryId);
  str(2, fields.title);
  str(3, fields.url);
  varint(4, fields.creationTimeUs);
  varint(5, fields.updateTimeUs);
  varint(6, fields.status);
  varint(7, fields.distillationState);
  str(8, fields.distilledPath);
  varint(17, fields.estimatedReadTimeSeconds);
  return concat(...parts);
}

function makeVersionEdit(opts: {
  logNumber?: bigint;
  prevLogNumber?: bigint;
  deletedFiles?: Array<{ level: number; number: bigint }>;
  newFiles?: Array<{ level: number; number: bigint; smallest: Uint8Array; largest: Uint8Array }>;
}): Uint8Array {
  const parts: Uint8Array[] = [encodeVarint32(1), lengthPrefixed(enc.encode("leveldb.BytewiseComparator"))];
  if (opts.logNumber !== undefined) parts.push(encodeVarint32(2), encodeVarint64(opts.logNumber));
  if (opts.prevLogNumber !== undefined) parts.push(encodeVarint32(9), encodeVarint64(opts.prevLogNumber));
  for (const del of opts.deletedFiles ?? []) {
    parts.push(encodeVarint32(6), encodeVarint32(del.level), encodeVarint64(del.number));
  }
  for (const file of opts.newFiles ?? []) {
    parts.push(
      encodeVarint32(7),
      encodeVarint32(file.level),
      encodeVarint64(file.number),
      encodeVarint64(1024n),
      lengthPrefixed(file.smallest),
      lengthPrefixed(file.largest),
    );
  }
  return concat(...parts);
}

describe("uncompressSnappy", () => {
  it("decodes literals, copy-1, copy-2, copy-4, and overlapping RLE copies", () => {
    // Expected: "abc" + "abcabcabc" (overlap copy-1: len=9 -> split 4+5 or copy-2 len=9) + "XYZ" + "abc" (copy-4)
    // Build: "abcd" (literal len 4) + RLE repeat "abcd" x 3 via copy-1 (offset=4, len=8 -> "abcdabcd")
    // + copy-2 (offset=12, len=4 -> "abcd") + copy-4 (offset=4, len=2 -> "ab")
    // Total length = 4 + 8 + 4 + 2 = 18 -> "abcdabcdabcdabcdab"
    const stream = new Uint8Array([
      18, // uncompressed length = 18
      (3 << 2) | 0, 0x61, 0x62, 0x63, 0x64, // literal "abcd"
      ((8 - 4) << 2) | 1, 4, // copy-1: len=8, offset=4 (overlap RLE)
      ((4 - 1) << 2) | 2, 12, 0, // copy-2: len=4, offset=12
      ((2 - 1) << 2) | 3, 4, 0, 0, 0, // copy-4: len=2, offset=4
    ]);
    assert.equal(new TextDecoder().decode(uncompressSnappy(stream)), "abcdabcdabcdabcdab");
  });

  it("decodes long literals (> 60 bytes)", () => {
    const payload = enc.encode("0123456789".repeat(12)); // 120 bytes
    const compressed = snappyLiteralOnly(payload);
    assert.deepEqual(uncompressSnappy(compressed), payload);
  });
});

describe("readLogRecords", () => {
  it("reassembles records split across 32KB block boundaries and ignores trailing padding", () => {
    const large = new Uint8Array(70000);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
    const small = enc.encode("hello-after-large");
    const log = makeLogFile([large, small]);
    const records = readLogRecords(log);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], large);
    assert.deepEqual(records[1], small);
  });
});

describe("decodeReadingListLocal", () => {
  it("decodes fields, UTF-8 titles, status defaults, and skips unknown fields", () => {
    const unreadBytes = encodeReadingListProto({
      entryId: "https://example.com/a",
      title: "日本語の記事タイトル",
      url: "https://example.com/a",
      creationTimeUs: 1000n,
      updateTimeUs: 2000n,
      status: 0,
      distillationState: 2,
      distilledPath: "/tmp/distilled",
      estimatedReadTimeSeconds: 180,
    });
    assert.deepEqual(decodeReadingListLocal(unreadBytes), {
      entryId: "https://example.com/a",
      title: "日本語の記事タイトル",
      url: "https://example.com/a",
      creationTimeUs: 1000n,
      updateTimeUs: 2000n,
      read: false,
    });

    const readBytes = encodeReadingListProto({
      title: "Done",
      url: "https://example.com/b",
      status: 1,
    });
    assert.equal(decodeReadingListLocal(readBytes)?.read, true);

    const defaultUnseenBytes = encodeReadingListProto({
      title: "Unseen",
      url: "https://example.com/c",
    });
    assert.equal(decodeReadingListLocal(defaultUnseenBytes)?.read, false);
  });
});

describe("readLevelDbPrefixes and readBookmarks", () => {
  it("reads SSTables (plain, snappy, zstd) + WAL updates/deletes and integrates with bookmarks", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-bookmark-fzf-"));
    try {
      const profileDir = join(root, "Default");
      const levelDbDir = join(profileDir, "Sync Data", "LevelDB");
      await mkdir(levelDbDir, { recursive: true });

      await writeFile(
        join(root, "Local State"),
        JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personal" } } } }),
      );

      await writeFile(
        join(profileDir, "Bookmarks"),
        JSON.stringify({
          roots: {
            bookmark_bar: {
              type: "folder",
              name: "Bookmarks Bar",
              children: [
                { type: "url", name: "Example Docs", url: "https://docs.example.com" },
              ],
            },
          },
        }),
      );

      const keepUrl = "https://example.com/keep";
      const updatedUrl = "https://example.com/updated";
      const deletedUrl = "https://example.com/deleted";
      const accountUrl = "https://example.com/account";
      const zstdUrl = "https://example.com/zstd";

      // SSTable 000003 (Snappy): contains local entries + non-reading-list key
      const table3 = makeSstable(
        [
          [
            [makeInternalKey(`A-reading_list-dt-${accountUrl}`, 5n, 1), encodeReadingListProto({
              title: "Account Newer",
              url: accountUrl,
              updateTimeUs: 5000n,
              status: 0,
            })],
            [makeInternalKey("bookmarks-dt-ignore", 6n, 1), enc.encode("ignore")],
          ],
          [
            [makeInternalKey(`reading_list-dt-${deletedUrl}`, 7n, 1), encodeReadingListProto({
              title: "Will Be Deleted",
              url: deletedUrl,
              updateTimeUs: 1000n,
              status: 0,
            })],
            [makeInternalKey(`reading_list-dt-${keepUrl}`, 8n, 1), encodeReadingListProto({
              title: "Read Article",
              url: keepUrl,
              updateTimeUs: 3000n,
              status: 1,
            })],
            [makeInternalKey(`reading_list-dt-${updatedUrl}`, 9n, 1), encodeReadingListProto({
              title: "Old Title",
              url: updatedUrl,
              updateTimeUs: 2000n,
              status: 0,
            })],
          ],
        ],
        1, // Snappy
      );
      await writeFile(join(levelDbDir, "000003.ldb"), table3);

      // SSTable 000004 (Zstd): contains another entry
      const table4 = makeSstable(
        [
          [
            [makeInternalKey(`reading_list-dt-${zstdUrl}`, 10n, 1), encodeReadingListProto({
              title: "Zstd Article",
              url: zstdUrl,
              creationTimeUs: 4000n,
              status: 2,
            })],
          ],
        ],
        2, // Zstd
      );
      await writeFile(join(levelDbDir, "000004.ldb"), table4);

      // Dead SSTable 000002 (deleted in MANIFEST) should be ignored
      const deadTable = makeSstable(
        [
          [
            [makeInternalKey("reading_list-dt-https://example.com/ghost", 99n, 1), encodeReadingListProto({
              title: "Ghost",
              url: "https://example.com/ghost",
              status: 0,
            })],
          ],
        ],
        0,
      );
      await writeFile(join(levelDbDir, "000002.ldb"), deadTable);

      // MANIFEST-000001
      const manifest = makeLogFile([
        makeVersionEdit({
          logNumber: 5n,
          newFiles: [
            {
              level: 0,
              number: 2n,
              smallest: makeInternalKey("reading_list-dt-a", 1n, 1),
              largest: makeInternalKey("reading_list-dt-z", 99n, 1),
            },
            {
              level: 1,
              number: 3n,
              smallest: makeInternalKey("A-reading_list-dt-", 5n, 1),
              largest: makeInternalKey("reading_list-dt-z", 9n, 1),
            },
          ],
        }),
        makeVersionEdit({
          logNumber: 6n,
          deletedFiles: [{ level: 0, number: 2n }],
          newFiles: [
            {
              level: 1,
              number: 4n,
              smallest: makeInternalKey(`reading_list-dt-${zstdUrl}`, 10n, 1),
              largest: makeInternalKey(`reading_list-dt-${zstdUrl}`, 10n, 1),
            },
          ],
        }),
      ]);
      await writeFile(join(levelDbDir, "MANIFEST-000001"), manifest);
      await writeFile(join(levelDbDir, "CURRENT"), "MANIFEST-000001\n");

      // Old WAL 000005.log (< logNumber 6) should be ignored
      await writeFile(
        join(levelDbDir, "000005.log"),
        makeLogFile([
          makeWriteBatch(50n, [
            {
              type: 1,
              key: "reading_list-dt-https://example.com/stale-wal",
              value: encodeReadingListProto({ title: "Stale WAL", url: "https://example.com/stale-wal" }),
            },
          ]),
        ]),
      );

      // Active WAL 000006.log: deletes deletedUrl, updates updatedUrl, adds older local duplicate of accountUrl, adds chrome:// ignored url
      await writeFile(
        join(levelDbDir, "000006.log"),
        makeLogFile([
          makeWriteBatch(20n, [
            { type: 0, key: `reading_list-dt-${deletedUrl}` },
            {
              type: 1,
              key: `reading_list-dt-${updatedUrl}`,
              value: encodeReadingListProto({
                title: "Updated Title",
                url: updatedUrl,
                updateTimeUs: 6000n,
                status: 0,
              }),
            },
            {
              type: 1,
              key: `reading_list-dt-${accountUrl}`,
              value: encodeReadingListProto({
                title: "Local Older Duplicate",
                url: accountUrl,
                updateTimeUs: 1000n,
                status: 1,
              }),
            },
            {
              type: 1,
              key: "reading_list-dt-chrome://settings",
              value: encodeReadingListProto({
                title: "Settings",
                url: "chrome://settings",
                status: 0,
              }),
            },
          ]),
        ]),
      );

      const signal = new AbortController().signal;
      const raw = await readLevelDbPrefixes(levelDbDir, ["A-reading_list-dt-", "reading_list-dt-"], signal);
      assert.equal(raw.has(`reading_list-dt-${deletedUrl}`), false);
      assert.equal(raw.has("bookmarks-dt-ignore"), false);

      const items = await readBookmarks(root, signal);
      assert.deepEqual(items, [
        {
          kind: "bookmark",
          title: "Example Docs",
          url: "https://docs.example.com",
          folder: "Bookmarks Bar",
          profile: "Default",
          profileName: "Personal",
        },
        {
          kind: "reading-list",
          title: "Updated Title",
          url: updatedUrl,
          folder: "Reading List",
          profile: "Default",
          profileName: "Personal",
          read: false,
        },
        {
          kind: "reading-list",
          title: "Account Newer",
          url: accountUrl,
          folder: "Reading List",
          profile: "Default",
          profileName: "Personal",
          read: false,
        },
        {
          kind: "reading-list",
          title: "Zstd Article",
          url: zstdUrl,
          folder: "Reading List",
          profile: "Default",
          profileName: "Personal",
          read: false,
        },
        {
          kind: "reading-list",
          title: "Read Article",
          url: keepUrl,
          folder: "Reading List",
          profile: "Default",
          profileName: "Personal",
          read: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
