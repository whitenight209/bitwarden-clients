import type { UpdateJournal } from "./update-files";

const DATABASE = "bitwarden-custom-extension-updates";
const TABLE = "state";

export type UpdateHistoryEntry = {
  at: number;
  fromVersion: string;
  toVersion: string;
  outcome: "applied" | "restored";
};

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/** A separate database: no vault records, passwords or account state are copied here. */
export async function getUpdateState<T>(key: string): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(TABLE, "readonly").objectStore(TABLE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function setUpdateState(key: string, value: unknown): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TABLE, "readwrite");
      if (value == null) {
        transaction.objectStore(TABLE).delete(key);
      } else {
        transaction.objectStore(TABLE).put(value, key);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Update storage transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Update state could not be saved."));
    });
  } finally {
    db.close();
  }
}

/** Save metadata-only history and remove every recovery byte in the same transaction. */
export async function finishUpdate(
  journal: UpdateJournal,
  outcome: UpdateHistoryEntry["outcome"],
): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TABLE, "readwrite");
      const table = transaction.objectStore(TABLE);
      const history = table.get("history");
      history.onsuccess = () => {
        const entry: UpdateHistoryEntry = {
          at: Date.now(),
          fromVersion: journal.fromVersion,
          toVersion: journal.toVersion,
          outcome,
        };
        table.put(
          [entry, ...((history.result as UpdateHistoryEntry[]) ?? [])].slice(0, 100),
          "history",
        );
        table.delete("journal");
        table.delete("backups");
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Update storage transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Update history could not be saved."));
    });
  } finally {
    db.close();
  }
}
