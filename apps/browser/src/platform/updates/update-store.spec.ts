import { deserialize, serialize } from "node:v8";

import { IDBFactory } from "fake-indexeddb";

import type { UpdateJournal } from "./update-files";
import { finishUpdate, getUpdateState, setUpdateState } from "./update-store";

const journal: UpdateJournal = {
  phase: "pendingReload",
  fromVersion: "1.0.0.1",
  toVersion: "1.0.0.2",
  baseline: new Uint8Array([1]),
  target: new Uint8Array([2]),
  backup: [{ path: "background.js", bytes: new Uint8Array([3, 4]) }],
};

beforeEach(() => {
  // jsdom lacks the browser primitive used by fake-indexeddb to persist typed arrays.
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    value: (value: unknown) => deserialize(serialize(value)),
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});

test("saves recovery bytes durably before completion and deletes them after a healthy update", async () => {
  await setUpdateState("journal", journal);
  await setUpdateState("backups", [journal]);
  expect(await getUpdateState("journal")).toEqual(journal);
  await finishUpdate(journal, "applied");
  expect(await getUpdateState("journal")).toBeUndefined();
  expect(await getUpdateState("backups")).toBeUndefined();
  expect(await getUpdateState("history")).toEqual([
    { at: expect.any(Number), fromVersion: "1.0.0.1", toVersion: "1.0.0.2", outcome: "applied" },
  ]);
});

test("cleanup preserves the folder reference and cached version checks", async () => {
  const folder = { name: "installed-folder" };
  await setUpdateState("directory", folder);
  await setUpdateState("checkResult", { checkedAt: 123 });
  await setUpdateState("journal", journal);
  await finishUpdate(journal, "restored");
  expect(await getUpdateState("directory")).toEqual(folder);
  expect(await getUpdateState("checkResult")).toEqual({ checkedAt: 123 });
  expect(await getUpdateState("journal")).toBeUndefined();
});

test("keeps at most 100 metadata-only results in newest-first order", async () => {
  const previous = Array.from({ length: 100 }, (_, at) => ({
    at,
    fromVersion: "1.0.0.0",
    toVersion: "1.0.0.1",
    outcome: "applied",
  }));
  await setUpdateState("history", previous);
  await finishUpdate(journal, "restored");
  const history = await getUpdateState<unknown[]>("history");
  expect(history).toHaveLength(100);
  expect(history?.[0]).toEqual({
    at: expect.any(Number),
    fromVersion: "1.0.0.1",
    toVersion: "1.0.0.2",
    outcome: "restored",
  });
  expect(JSON.stringify(history)).not.toMatch(/backup|baseline|target|bytes/);
});

test("a failed completion transaction retains recovery files and the previous history", async () => {
  await setUpdateState("journal", journal);
  await setUpdateState("history", ["previous"]);
  const open = indexedDB.open("bitwarden-custom-extension-updates", 1);
  const db = await new Promise<IDBDatabase>((resolve) => {
    open.onsuccess = () => resolve(open.result);
  });
  const original = db.transaction.bind(db);
  const transaction = jest
    .spyOn(Object.getPrototypeOf(db), "transaction")
    .mockImplementation(function (this: IDBDatabase, ...args: unknown[]) {
      const tx = original(args[0] as string, args[1] as IDBTransactionMode);
      if (args[1] === "readwrite") {
        const store = tx.objectStore("state");
        const originalDelete = store.delete.bind(store);
        jest.spyOn(store, "delete").mockImplementation((key) => {
          const result = originalDelete(key);
          if (key === "backups") {
            tx.abort();
          }
          return result;
        });
        jest.spyOn(tx, "objectStore").mockReturnValue(store);
      }
      return tx;
    });
  try {
    await expect(finishUpdate(journal, "applied")).rejects.toThrow();
  } finally {
    transaction.mockRestore();
    db.close();
  }
  expect(await getUpdateState("journal")).toEqual(journal);
  expect(await getUpdateState("history")).toEqual(["previous"]);
});
