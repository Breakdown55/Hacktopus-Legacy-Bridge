import { createPgDb } from './pg';
import { migrate } from './migrate';

const db = createPgDb();
migrate(db).then((applied) => { console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date'); return db.close(); }).catch((e) => { console.error('migration failed:', (e as Error).message); process.exit(1); });
