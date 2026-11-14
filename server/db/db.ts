/** Minimal driver-neutral interface satisfied by node-postgres (production) and PGlite (tests). */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run multi-statement SQL with no parameters (migrations). */
  exec(text: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
