/** Recognizes native executable containers by magic bytes. Content is never executed or fully parsed in the browser. */
export type ExecutableKind = 'ELF' | 'PE' | 'Mach-O';

export function detectExecutable(head: Uint8Array): ExecutableKind | null {
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'ELF';
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'PE';
  if (head.length >= 4) {
    const magic = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    // Mach-O thin (either endianness) and fat/universal; 0xcafebabe is shared with Java classes, which the backend inspector also treats as Mach-O.
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'Mach-O';
  }
  return null;
}

export async function readExecutableKind(file: Blob): Promise<ExecutableKind | null> {
  return detectExecutable(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
}

export const notExecutableMessage = 'That file is not a recognized executable (ELF, PE or Mach-O). Choose the program itself, not a document or source file.';
