import { crc32 } from 'node:zlib';

/** MS-DOS date and time fields (UTC, 2-second resolution). The format cannot express anything before 1980. */
function dosTime(at: Date) {
  const year = Math.min(2107, Math.max(1980, at.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
  };
}

/**
 * Deterministic zip: stored (no compression), entries sorted by path. Every entry carries `modified`, so the same inputs and the same
 * time give the same bytes. Without a time the entries read 1980-01-01, the earliest date the format can hold.
 */
export function zip(files: { path: string; content: Buffer }[], modified: Date = new Date(Date.UTC(1980, 0, 1))): Buffer {
  const stamp = dosTime(Number.isNaN(modified.getTime()) ? new Date(Date.UTC(1980, 0, 1)) : modified);
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = Buffer.from(f.path, 'utf8');
    const crc = crc32(f.content) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(stamp.time, 10); lh.writeUInt16LE(stamp.date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.content.length, 18); lh.writeUInt32LE(f.content.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(stamp.time, 12); ch.writeUInt16LE(stamp.date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.content.length, 20); ch.writeUInt32LE(f.content.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    local.push(lh, name, f.content); central.push(ch, name);
    offset += 30 + name.length + f.content.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
