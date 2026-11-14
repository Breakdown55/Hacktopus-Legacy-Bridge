import type { Db } from '../db/db';
import type { BlobStore } from '../storage/blobstore';

export interface Ctx { db: Db; store: BlobStore; orgId: string; userId: string | null }
