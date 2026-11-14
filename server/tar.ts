/** Minimal deterministic ustar writer/reader (regular files only; sorted, mtime=0, uid/gid=0). */
const pad = (n: number) => (512 - (n % 512)) % 512;
const oct = (n: number, w: number) => n.toString(8).padStart(w - 1, '0') + '\0';

export function packTar(files: { path: string; content: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = Buffer.from(f.path);
    if (name.length > 100) throw new Error(`path too long: ${f.path}`);
    const h = Buffer.alloc(512);
    name.copy(h, 0);
    h.write(oct(0o644, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
    h.write(oct(f.content.length, 12), 124); h.write(oct(0, 12), 136);
    h.fill(0x20, 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, f.content, Buffer.alloc(pad(f.content.length)));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function unpackTar(buf: Buffer): { path: string; content: Buffer }[] {
  const out: { path: string; content: Buffer }[] = [];
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('latin1', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(h.toString('latin1', 124, 135), 8);
    const type = h[156];
    o += 512;
    if (type === 0x30 || type === 0) out.push({ path: name, content: Buffer.from(buf.subarray(o, o + size)) });
    o += size + pad(size);
  }
  return out;
}
