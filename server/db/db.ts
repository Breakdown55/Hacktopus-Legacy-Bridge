/** Minimal driver-neutral interface satisfied by node-postgres (production) and PGlite (tests). */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run multi-statement SQL with no parameters (migrations). */
  exec(text: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` on ONE dedicated connection that acts as role `lb_api` with `app.org_id` set to `orgId`, so row-level security
   * (migration 0003) confines every statement to that organization even if a query forgets its `org_id` filter.
   * The role and setting are always reset before the connection is reused. `tx` works at depth 0; `withOrg` does not nest.
   */
  withOrg<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T>;
}

export const API_ROLE = 'lb_api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Org ids go into a session setting; refuse anything that is not a UUID before it gets near SQL. */
export function assertOrgId(orgId: string): string {
  if (!UUID.test(orgId)) throw new Error('invalid org id');
  return orgId.toLowerCase();
}
