export type Attachment = { id: string; projectId: string; file: File };

let mediaDatabase: Promise<IDBDatabase> | undefined;

function openMediaDatabase(): Promise<IDBDatabase> {
  if (!mediaDatabase) {
    mediaDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('legacy-bridge-context', 1);
      request.onupgradeneeded = () => {
        const attachments = request.result.createObjectStore('attachments', { keyPath: 'id' });
        attachments.createIndex('projectId', 'projectId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      mediaDatabase = undefined;
      throw error;
    });
  }
  return mediaDatabase;
}

export async function accessAttachments<T = unknown>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const database = await openMediaDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction('attachments', mode);
    const result = operation(transaction.objectStore('attachments'));
    transaction.oncomplete = () => resolve((result as IDBRequest<T> | undefined)?.result as T);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const listAttachments = (projectId: string) =>
  accessAttachments<Attachment[]>('readonly', store => store.index('projectId').getAll(projectId));

export const getAttachment = (id: string) =>
  accessAttachments<Attachment | undefined>('readonly', store => store.get(id));

export const addAttachments = (projectId: string, files: File[]) =>
  accessAttachments('readwrite', store => {
    for (const file of files) store.add({ id: crypto.randomUUID(), projectId, file });
  });

export const removeAttachment = (id: string) =>
  accessAttachments('readwrite', store => {
    store.delete(id);
  });

export const removeProjectAttachments = (projectId: string) =>
  accessAttachments('readwrite', store => {
    const request = store.index('projectId').openKeyCursor(projectId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
