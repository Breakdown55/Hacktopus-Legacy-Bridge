import type { Db } from './db/db';
import type { BlobStore } from './storage/blobstore';

export interface App { db: Db; store: BlobStore }
let app: App | null = null;

/** Tests inject their own app; production builds one lazily from the environment. */
export function setApp(a: App | null) { app = a; }

export async function getApp(): Promise<App> {
  if (app) return app;
  const { createPgDb } = await import('./db/pg');
  const { S3BlobStore } = await import('./storage/s3');
  if (!process.env.DATABASE_URL || !process.env.S3_BUCKET) throw new Error('DATABASE_URL and S3_BUCKET are required');
  app = { db: createPgDb(), store: new S3BlobStore(process.env.S3_BUCKET, { endpoint: process.env.S3_ENDPOINT || undefined, region: process.env.S3_REGION }) };
  return app;
}
