import { createPgDb } from './pg';

async function main() {
  const { LB_DEV_AUTH, LB_S1_ORG_ID, LB_S1_USER_ID, DATABASE_URL } = process.env;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (process.env.NODE_ENV === 'production' || LB_DEV_AUTH !== '1' || !DATABASE_URL
    || !LB_S1_ORG_ID || !uuid.test(LB_S1_ORG_ID) || !LB_S1_USER_ID || !uuid.test(LB_S1_USER_ID)) {
    throw new Error('Local dev only. Set LB_DEV_AUTH=1, DATABASE_URL, LB_S1_ORG_ID, and LB_S1_USER_ID.');
  }
  const db = createPgDb(DATABASE_URL);
  try {
    await db.tx(async tx => {
      await tx.query("INSERT INTO organizations(id,name,execution_enabled) VALUES ($1,'Local S1',true) ON CONFLICT DO NOTHING", [LB_S1_ORG_ID]);
      await tx.query("INSERT INTO users(id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING", [LB_S1_USER_ID, LB_S1_USER_ID + '@s1.invalid']);
      await tx.query("INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING", [LB_S1_ORG_ID, LB_S1_USER_ID]);
    });
    console.log('Local S1 development identity is ready.');
  } finally { await db.close(); }
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
