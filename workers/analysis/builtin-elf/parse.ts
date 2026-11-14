/**
 * Built-in deterministic ELF inspector. Parses bytes only; it never executes anything (no ldd).
 * Produces facts plus separate analysis and execution eligibility (§1.2, §4.1).
 */
import type { AnalysisEligibility, ExecutionEligibility } from '@lb/contracts';

export interface Inspection {
  format: 'ELF64' | 'ELF32' | 'PE' | 'MachO' | 'script' | 'unknown';
  arch?: string;
  type?: string;
  interpreter?: string | null;
  needed: string[];
  linking?: 'dynamic' | 'static';
  stripped?: boolean;
  hardening?: { pie: boolean; nx: boolean; relro: 'none' | 'partial' | 'full' };
  sections: { name: string; type: number; size: number; offset: number }[];
  max_glibc?: string | null;
  strings: { offset: number; value: string }[];
}

export interface Eligibility {
  analysis: AnalysisEligibility;
  execution: ExecutionEligibility;
  reasons: string[];
}

const MACHINES: Record<number, string> = { 0x3e: 'x86-64', 0x03: 'i386', 0xb7: 'aarch64', 0x28: 'arm', 0xf3: 'riscv' };
const TYPES: Record<number, string> = { 1: 'ET_REL', 2: 'ET_EXEC', 3: 'ET_DYN', 4: 'ET_CORE' };
const PT = { LOAD: 1, DYNAMIC: 2, INTERP: 3, GNU_RELRO: 0x6474e552, GNU_STACK: 0x6474e551 };
const DT = { NULL: 0, NEEDED: 1, STRTAB: 5, FLAGS: 30, FLAGS_1: 0x6ffffffb };
const DF_BIND_NOW = 0x8;
const DF_1_NOW = 0x1;

const MAX_STRINGS = 5000;

export function extractStrings(buf: Buffer, min = 4): { offset: number; value: string }[] {
  const out: { offset: number; value: string }[] = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= min) {
        out.push({ offset: start, value: buf.toString('latin1', start, Math.min(i, start + 256)) });
        if (out.length >= MAX_STRINGS) break;
      }
      start = -1;
    }
  }
  return out;
}

const cstr = (buf: Buffer, off: number, limit = 4096): string => {
  if (off < 0 || off >= buf.length) return '';
  let e = off;
  while (e < buf.length && buf[e] !== 0 && e - off < limit) e++;
  return buf.toString('latin1', off, e);
};

export function inspectElf(buf: Buffer): Inspection {
  const base: Inspection = { format: 'unknown', needed: [], sections: [], strings: [] };
  if (buf.length >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return { ...base, format: 'script' };
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return { ...base, format: 'PE' };
  if (buf.length >= 4) {
    const m = buf.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return { ...base, format: 'MachO' };
  }
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return base;

  const cls = buf[4];
  if (cls === 1) return { ...base, format: 'ELF32', arch: MACHINES[buf.readUInt16LE(18)] ?? 'unknown' };
  if (cls !== 2 || buf[5] !== 1) return base; // big-endian ELF64 not supported
  const r = {
    u16: (o: number) => buf.readUInt16LE(o),
    u32: (o: number) => buf.readUInt32LE(o),
    u64: (o: number) => Number(buf.readBigUInt64LE(o)),
  };
  const type = r.u16(16);
  const arch = MACHINES[r.u16(18)] ?? `unknown(0x${r.u16(18).toString(16)})`;
  const phoff = r.u64(32);
  const shoff = r.u64(40);
  const phentsize = r.u16(54);
  const phnum = r.u16(56);
  const shentsize = r.u16(58);
  const shnum = r.u16(60);
  const shstrndx = r.u16(62);

  const phdrs: { type: number; flags: number; offset: number; vaddr: number; filesz: number; memsz: number }[] = [];
  for (let i = 0; i < phnum && phoff + (i + 1) * phentsize <= buf.length; i++) {
    const o = phoff + i * phentsize;
    phdrs.push({ type: r.u32(o), flags: r.u32(o + 4), offset: r.u64(o + 8), vaddr: r.u64(o + 16), filesz: r.u64(o + 32), memsz: r.u64(o + 40) });
  }
  const vaddrToOff = (v: number): number => {
    for (const p of phdrs) if (p.type === PT.LOAD && v >= p.vaddr && v < p.vaddr + p.filesz) return v - p.vaddr + p.offset;
    return -1;
  };

  const interp = phdrs.find((p) => p.type === PT.INTERP);
  const interpreter = interp ? cstr(buf, interp.offset, interp.filesz) : null;
  const dyn = phdrs.find((p) => p.type === PT.DYNAMIC);

  const needed: string[] = [];
  let bindNow = false;
  if (dyn && dyn.offset + dyn.filesz <= buf.length) {
    const neededOffs: number[] = [];
    let strtab = 0;
    for (let o = dyn.offset; o + 16 <= dyn.offset + dyn.filesz; o += 16) {
      const tag = r.u64(o);
      const val = r.u64(o + 8);
      if (tag === DT.NULL) break;
      if (tag === DT.NEEDED) neededOffs.push(val);
      else if (tag === DT.STRTAB) strtab = val;
      else if (tag === DT.FLAGS && val & DF_BIND_NOW) bindNow = true;
      else if (tag === DT.FLAGS_1 && val & DF_1_NOW) bindNow = true;
    }
    const strOff = vaddrToOff(strtab);
    if (strOff >= 0) for (const n of neededOffs) needed.push(cstr(buf, strOff + n));
  }

  const sections: Inspection['sections'] = [];
  let hasSymtab = false;
  if (shoff > 0 && shnum > 0 && shoff + shnum * shentsize <= buf.length) {
    const shdr = (i: number) => {
      const o = shoff + i * shentsize;
      return { name: r.u32(o), type: r.u32(o + 4), offset: r.u64(o + 24), size: r.u64(o + 32) };
    };
    const strsec = shstrndx < shnum ? shdr(shstrndx) : null;
    for (let i = 0; i < shnum; i++) {
      const s = shdr(i);
      const name = strsec ? cstr(buf, strsec.offset + s.name, 256) : '';
      if (name === '.symtab') hasSymtab = true;
      sections.push({ name, type: s.type, size: s.size, offset: s.offset });
    }
  }

  const relro = phdrs.some((p) => p.type === PT.GNU_RELRO);
  const stack = phdrs.find((p) => p.type === PT.GNU_STACK);
  const strings = extractStrings(buf);
  let max: [number, number] | null = null;
  for (const s of strings) {
    for (const m of s.value.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      const v: [number, number] = [Number(m[1]), Number(m[2])];
      if (!max || v[0] > max[0] || (v[0] === max[0] && v[1] > max[1])) max = v;
    }
  }

  return {
    format: 'ELF64',
    arch,
    type: TYPES[type] ?? `unknown(${type})`,
    interpreter,
    needed,
    linking: dyn || interp ? 'dynamic' : 'static',
    stripped: !hasSymtab,
    hardening: { pie: type === 3, nx: stack ? (stack.flags & 1) === 0 : false, relro: relro ? (bindNow ? 'full' : 'partial') : 'none' },
    sections,
    max_glibc: max ? `${max[0]}.${max[1]}` : null,
    strings,
  };
}

export interface RunImage {
  /** sonames provided by the run image base layer */
  libraries: string[];
  glibc: string;
}

const cmpVer = (a: string, b: string) => {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
};

/** Static eligibility from inspection facts (no execution). Execution stays `unknown` until a probe confirms it. */
export function classify(i: Inspection, ctx: { suppliedLibraries: string[]; image: RunImage; executionEnabled: boolean; consent: boolean }): Eligibility {
  if (i.format === 'PE' || i.format === 'MachO' || i.format === 'script' || i.format === 'unknown') {
    return { analysis: 'ineligible', execution: 'unsupported', reasons: [`format:${i.format === 'MachO' ? 'macho' : i.format.toLowerCase()}`] };
  }
  const reasons: string[] = [];
  if (i.format === 'ELF32') return { analysis: 'partial', execution: 'unsupported', reasons: ['arch:i386'] };
  if (i.arch !== 'x86-64') return { analysis: 'partial', execution: 'unsupported', reasons: [`arch:${i.arch}`] };
  if (i.type !== 'ET_EXEC' && i.type !== 'ET_DYN') return { analysis: 'ineligible', execution: 'unsupported', reasons: [`type:${i.type}`] };

  let execution: ExecutionEligibility = 'unknown';
  const have = new Set([...ctx.image.libraries, ...ctx.suppliedLibraries]);
  const missing = i.needed.filter((n) => !have.has(n));
  if (missing.length) {
    execution = 'not_runnable';
    reasons.push(...missing.map((m) => `missing_library:${m}`));
  } else if (i.max_glibc && cmpVer(i.max_glibc, ctx.image.glibc) > 0) {
    execution = 'unsupported';
    reasons.push(`glibc_too_new:${i.max_glibc}`);
  } else if (!ctx.executionEnabled) {
    execution = 'not_permitted';
    reasons.push('execution_disabled');
  } else if (!ctx.consent) {
    execution = 'not_permitted';
    reasons.push('consent_missing');
  } else reasons.push('probe_not_run');
  return { analysis: 'eligible', execution, reasons };
}
