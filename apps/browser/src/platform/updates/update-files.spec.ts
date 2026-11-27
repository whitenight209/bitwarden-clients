import { webcrypto } from "node:crypto";
import { serialize, deserialize } from "node:v8";

import { UpdateInventory, fileChanges, sha256 } from "./update-contract";
import {
  UpdateDirectory,
  UpdateJournal,
  applyUpdateFiles,
  rollbackUpdate,
  verifyManifestChange,
} from "./update-files";

beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }),
);

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const identity = {
  productId: "custom",
  browser: "chrome" as const,
  flavor: "oss",
  channel: "stable",
};
const manifest = (version: string) => ({
  version,
  key: "fixed-key",
  manifest_version: 3,
  permissions: ["storage"],
  background: { service_worker: "background.js" },
});

/** Models actual directory traversal and atomic per-file writable streams, not updater internals. */
class MemoryDirectory implements UpdateDirectory {
  permission: PermissionState = "granted";
  failOnce?: string;
  writes: string[] = [];
  constructor(
    readonly files = new Map<string, Uint8Array>(),
    private prefix = "",
    private owner?: MemoryDirectory,
  ) {}
  private get root(): MemoryDirectory {
    return this.owner ?? this;
  }
  async getDirectoryHandle(name: string) {
    return new MemoryDirectory(this.files, this.prefix + name + "/", this.root);
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const path = this.prefix + name;
    if (!options?.create && !this.files.has(path)) {
      throw new DOMException("Not found", "NotFoundError");
    }
    return {
      getFile: async () => ({
        arrayBuffer: async () => this.files.get(path)!.slice().buffer as ArrayBuffer,
      }),
      createWritable: async () => {
        let staged: Uint8Array;
        return {
          write: async (bytes: Uint8Array) => {
            staged = bytes.slice();
          },
          close: async () => {
            if (this.root.failOnce === path) {
              this.root.failOnce = undefined;
              throw new Error("Disk write failed");
            }
            this.root.writes.push(path);
            this.files.set(path, staged);
          },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name: string) {
    const path = this.prefix + name;
    if (this.root.failOnce === path) {
      this.root.failOnce = undefined;
      throw new Error("Disk delete failed");
    }
    if (!this.files.delete(path)) {
      throw new DOMException("Not found", "NotFoundError");
    }
  }
  async *entries(): AsyncIterableIterator<[string, { kind: "file" | "directory" }]> {
    const names = new Map<string, "file" | "directory">();
    for (const path of this.files.keys()) {
      if (path.startsWith(this.prefix)) {
        const relative = path.slice(this.prefix.length);
        const parts = relative.split("/");
        names.set(parts[0], parts.length > 1 ? "directory" : "file");
      }
    }
    for (const [name, kind] of names) {
      yield [name, { kind }];
    }
  }
  async queryPermission() {
    return this.root.permission;
  }
  async requestPermission() {
    return this.root.permission;
  }
}

async function inventory(
  files: Map<string, Uint8Array>,
  version: string,
): Promise<UpdateInventory> {
  return {
    ...identity,
    schemaVersion: 1,
    version,
    commit: "commit",
    files: Object.fromEntries(
      await Promise.all(
        [...files].map(async ([path, bytes]) => [
          path,
          { size: bytes.length, sha256: await sha256(bytes) },
        ]),
      ),
    ),
  };
}

async function fixture() {
  const files = new Map([
    ["manifest.json", encode(manifest("1.0.0.1"))],
    ["background.js", encode("old")],
    ["popup/unchanged.css", encode("same")],
    ["obsolete.js", encode("remove")],
  ]);
  const base = await inventory(files, "1.0.0.1");
  const baseline = encode(base);
  const targetFiles = new Map(files);
  targetFiles.set("manifest.json", encode(manifest("1.0.0.2")));
  targetFiles.set("background.js", encode("new"));
  targetFiles.set("assets/new.wasm", new Uint8Array([0, 97, 115, 109]));
  targetFiles.delete("obsolete.js");
  const targetInventory = await inventory(targetFiles, "1.0.0.2");
  const target = encode(targetInventory);
  const payload = new Map(
    fileChanges(base, targetInventory).write.map((path) => [path, targetFiles.get(path)!]),
  );
  const root = new MemoryDirectory(new Map([...files, ["custom-update-installed.json", baseline]]));
  let journal: UpdateJournal | null = null;
  const phases: string[] = [];
  const save = jest.fn(async (value: UpdateJournal | null) => {
    journal = value == null ? null : deserialize(serialize(value));
    phases.push(value?.phase ?? "cleared");
  });
  return {
    root,
    base,
    baseline,
    target,
    targetInventory,
    payload,
    targetFiles,
    save,
    journal: () => journal,
    phases,
  };
}

test("applies changed binary files and deletion, keeps identical files, and writes manifest last", async () => {
  const f = await fixture();
  await applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save);
  expect(f.root.files.get("assets/new.wasm")).toEqual(f.targetFiles.get("assets/new.wasm"));
  expect(f.root.files.has("obsolete.js")).toBe(false);
  expect(f.root.writes).not.toContain("popup/unchanged.css");
  expect(f.root.writes.slice(-2)).toEqual(["manifest.json", "custom-update-installed.json"]);
  expect(f.journal()?.phase).toBe("pendingReload");
  expect(f.phases[0]).toBe("applying");
});

test("a full snapshot can skip intermediate versions while still writing only changes", async () => {
  const f = await fixture();
  const payload = new Map([...f.targetFiles, ["custom-update-installed.json", f.target]]);
  await applyUpdateFiles(f.root, f.baseline, f.target, payload, f.save);
  expect(f.root.writes).not.toContain("popup/unchanged.css");
});

test.each(["background.js", "obsolete.js"])(
  "restores every old byte after failure at %s",
  async (path) => {
    const f = await fixture();
    const original = new Map(f.root.files);
    f.root.failOnce = path;
    await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
      /Disk/,
    );
    expect([...f.root.files].sort()).toEqual([...original].sort());
    expect(f.journal()).toBeNull();
  },
);

test("an applying journal can recover an interrupted transaction on next startup", async () => {
  const f = await fixture();
  await applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save);
  const journal = f.journal()!;
  await rollbackUpdate(f.root, journal, f.save);
  expect(new TextDecoder().decode(f.root.files.get("background.js"))).toBe("old");
  expect(f.root.files.has("assets/new.wasm")).toBe(false);
  expect(f.journal()).toBeNull();
});

test("a durable journal failure happens before any local file is changed", async () => {
  const f = await fixture();
  await expect(
    applyUpdateFiles(f.root, f.baseline, f.target, f.payload, async () => {
      throw new Error("Quota exceeded");
    }),
  ).rejects.toThrow("Quota");
  expect(f.root.writes).toEqual([]);
});

test("revoked folder permission prevents all writes", async () => {
  const f = await fixture();
  f.root.permission = "prompt";
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /write access/,
  );
  expect(f.save).not.toHaveBeenCalled();
  expect(f.root.writes).toEqual([]);
});

test("refuses tampered or missing payload files before backing up or writing", async () => {
  const f = await fixture();
  f.payload.set("background.js", encode("tampered"));
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /integrity/,
  );
  expect(f.save).not.toHaveBeenCalled();
  f.payload.delete("background.js");
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /missing/,
  );
});

test("refuses locally modified and untracked installation files", async () => {
  const f = await fixture();
  f.root.files.set("background.js", encode("local modification"));
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /integrity/,
  );
  f.root.files.set("untracked.js", encode("unexpected"));
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /untracked/,
  );
  expect(f.save).not.toHaveBeenCalled();
});

test("refuses unexpected payload files and wrong full-archive installation metadata", async () => {
  const f = await fixture();
  f.payload.set("extra.js", encode("unexpected"));
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /Unexpected/,
  );
  f.payload.delete("extra.js");
  f.payload.set("custom-update-installed.json", f.baseline);
  await expect(applyUpdateFiles(f.root, f.baseline, f.target, f.payload, f.save)).rejects.toThrow(
    /installed inventory/,
  );
});

test("refuses same-version and downgraded updates", async () => {
  const f = await fixture();
  await expect(applyUpdateFiles(f.root, f.baseline, f.baseline, f.payload, f.save)).rejects.toThrow(
    /increase/,
  );
});

test.each([
  "permissions",
  "optional_permissions",
  "host_permissions",
  "content_security_policy",
  "background",
])("requires manual installation when %s changes", (key) => {
  const base = manifest("1.0.0.1");
  expect(() =>
    verifyManifestChange(base, { ...manifest("1.0.0.2"), [key]: ["changed"] }, "1.0.0.2"),
  ).toThrow();
});

test("never silently changes the extension ID", () => {
  expect(() =>
    verifyManifestChange(manifest("1"), { ...manifest("2"), key: "another-key" }, "2"),
  ).toThrow();
});

test("accepts an increasing version when neither manifest has a key", () => {
  const base: Record<string, unknown> = manifest("1");
  const target: Record<string, unknown> = manifest("2");
  delete base.key;
  delete target.key;
  expect(() => verifyManifestChange(base, target, "2")).not.toThrow();
});
