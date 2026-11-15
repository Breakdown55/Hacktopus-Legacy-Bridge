/**
 * What a project packages its modernized code for. Chosen when the project is created.
 * `supported: false` targets can be chosen and are recorded, but generation, build and verification exist for TypeScript only today:
 * the server refuses module work for the others (409 target_not_supported) rather than quietly producing TypeScript.
 */
export const TARGET_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript (Node.js 22)', supported: true },
  { id: 'python', label: 'Python', supported: false },
  { id: 'go', label: 'Go', supported: false },
  { id: 'java', label: 'Java', supported: false },
  { id: 'csharp', label: 'C#', supported: false },
] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]['id'];
export const TARGET_IDS = TARGET_LANGUAGES.map((t) => t.id) as [TargetLanguage, ...TargetLanguage[]];
export const targetOf = (id: string | null | undefined) => TARGET_LANGUAGES.find((t) => t.id === id) ?? TARGET_LANGUAGES[0];
