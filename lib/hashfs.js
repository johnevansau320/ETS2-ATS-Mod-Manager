// Minimal HashFS (SCS#) reader: pulls a single small file (manifest.sii, mod_icon.*) out of a mod archive.
// Supports v1 (directory table at start_offset) and v2 (compressed entry + metadata tables).
const fs = require('fs');
const zlib = require('zlib');

const M = (1n << 64n) - 1n;
const K2 = 0x9ae16a3b2f90404fn, KMUL = 0x9ddfea08eb382d69n;
const rot = (v, s) => (((v >> BigInt(s)) | (v << BigInt(64 - s))) & M);

function hashLen16(u, v, mul = KMUL) {
  let a = ((u ^ v) * mul) & M; a ^= a >> 47n;
  let b = ((v ^ a) * mul) & M; b ^= b >> 47n;
  return (b * mul) & M;
}

// CityHash64 (v1.0.3, the variant SCS uses) for inputs of 8..16 bytes: enough for "manifest.sii" and
// "mod_icon.jpg"; other lengths unsupported. Verified against real archives (see manifest lookups).
function cityHash64Short(buf) {
  const len = buf.length;
  if (len < 8 || len > 16) throw new Error('unsupported length');
  const a = buf.readBigUInt64LE(0), b = buf.readBigUInt64LE(len - 8), L = BigInt(len);
  const v = (b + L) & M;
  const r = ((v >> L) | (v << (64n - L))) & M;
  return hashLen16(a, r) ^ b;
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

function inflateMaybe(buf, compressed) {
  if (!compressed) return buf;
  return zlib.inflateSync(buf);
}

// Returns Buffer for the requested path, or null if absent/unsupported.
function readFileFromHashFs(file, relPath, maxSize = 2 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readAt(fd, 0, 64);
    if (head.toString('latin1', 0, 4) !== 'SCS#') return null;
    const version = head.readUInt16LE(4);
    if (head.toString('latin1', 8, 12) !== 'CITY') return null;
    const target = cityHash64Short(Buffer.from(relPath, 'utf8'));

    if (version === 2) {
      const entryCount = head.readUInt32LE(12), entryLen = head.readUInt32LE(16), metaLen = head.readUInt32LE(24);
      const entryStart = Number(head.readBigUInt64LE(28)), metaStart = Number(head.readBigUInt64LE(36));
      const entries = zlib.inflateSync(readAt(fd, entryStart, entryLen));
      let metaIndex = -1;
      for (let i = 0; i < entryCount; i++) {
        if (entries.readBigUInt64LE(i * 16) === target) { metaIndex = entries.readUInt32LE(i * 16 + 8); break; }
      }
      if (metaIndex < 0) return null;
      const meta = zlib.inflateSync(readAt(fd, metaStart, metaLen));
      const hdr = meta.readUInt32LE(metaIndex * 4);
      if (hdr >>> 24 !== 0x80) return null;                         // plain file data only
      const w1 = meta.readUInt32LE(metaIndex * 4 + 4), w2 = meta.readUInt32LE(metaIndex * 4 + 8), w4 = meta.readUInt32LE(metaIndex * 4 + 16);
      const csize = w1 & 0x0fffffff, size = w2 & 0x0fffffff, compressed = (w1 >>> 28) !== 0;
      if (size > maxSize) return null;
      return inflateMaybe(readAt(fd, w4 * 16, csize), compressed);
    }

    if (version === 1) {
      const entryCount = head.readUInt32LE(12), start = head.readUInt32LE(16);
      const table = readAt(fd, start, entryCount * 32);
      for (let i = 0; i < entryCount; i++) {
        if (table.readBigUInt64LE(i * 32) !== target) continue;
        const offset = Number(table.readBigUInt64LE(i * 32 + 8)), flags = table.readUInt32LE(i * 32 + 16);
        const size = table.readUInt32LE(i * 32 + 24), csize = table.readUInt32LE(i * 32 + 28);
        if (flags & 1 || size > maxSize) return null;               // directory
        return inflateMaybe(readAt(fd, offset, csize), (flags & 2) !== 0);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readFileFromHashFs, cityHash64Short };
