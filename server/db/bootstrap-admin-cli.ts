import { createPgDb } from './pg';
import { bootstrapAdmin } from './bootstrap-admin';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = createPgDb();
bootstrapAdmin(db, { email: arg('email') ?? '', org: arg('org') ?? '' })
  .then((r) => { console.log(`org ${r.org_id}, user ${r.user_id}, ${r.created_membership ? 'admin membership created' : 'already a member (now admin)'}`); return db.close(); })
  .catch((e) => { console.error('bootstrap-admin failed:', (e as Error).message); process.exit(1); });
