/** Reusable module target, selected when a project is created. */
export const TARGET_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript (Node.js 22)', name: 'TypeScript', extension: 'ts', runtime: 'node22', entry: 'src/index.ts', symbol: 'run' },
  { id: 'python', label: 'Python 3.12', name: 'Python', extension: 'py', runtime: 'python312', entry: 'src/replacement.py', symbol: 'run' },
  { id: 'go', label: 'Go 1.24', name: 'Go', extension: 'go', runtime: 'go124', entry: 'src/replacement.go', symbol: 'Run' },
  { id: 'java', label: 'Java 21', name: 'Java', extension: 'java', runtime: 'java21', entry: 'src/Replacement.java', symbol: 'Replacement.run' },
  { id: 'csharp', label: 'C# (.NET 8)', name: 'C#', extension: 'cs', runtime: 'dotnet8', entry: 'src/Replacement.cs', symbol: 'Replacement.Run' },
] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]['id'];
export const TARGET_IDS = TARGET_LANGUAGES.map((t) => t.id) as [TargetLanguage, ...TargetLanguage[]];
export const targetOf = (id: string | null | undefined) => TARGET_LANGUAGES.find((t) => t.id === id) ?? TARGET_LANGUAGES[0];
export const targetEnvironment = (id: TargetLanguage) => 'replacement-' + targetOf(id).runtime;
export const moduleTarget = (id: TargetLanguage) => id + '-' + targetOf(id).runtime;
export const moduleLanguage = (target: string) => TARGET_IDS.find(id => moduleTarget(id) === target);
