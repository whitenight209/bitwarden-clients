import JSZip from "jszip";

import {
  CONFIG_FILE,
  INSTALLED_FILE,
  UpdateInventory,
  compareVersions,
  fileChanges,
  hasOwn,
  validateInventory,
  validatePath,
  validateZip,
  verifyDigest,
} from "./update-contract";

/** A structural subset of File System Access, also implementable by a test filesystem. */
export interface UpdateDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<UpdateDirectory>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    createWritable(): Promise<{
      write(data: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterableIterator<[string, { kind: "file" | "directory" }]>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
}

export type UpdateJournal = {
  phase: "applying" | "pendingReload";
  fromVersion: string;
  toVersion: string;
  baseline: Uint8Array;
  target: Uint8Array;
  backup: Array<{ path: string; bytes: Uint8Array | null }>;
};

async function parent(root: UpdateDirectory, path: string, create = false) {
  const components = validatePath(path).split("/");
  const name = components.pop()!;
  let directory = root;
  for (const component of components) {
    directory = await directory.getDirectoryHandle(component, { create });
  }
  return { directory, name };
}

export async function readUpdateFile(root: UpdateDirectory, path: string): Promise<Uint8Array> {
  const { directory, name } = await parent(root, path);
  const handle = await directory.getFileHandle(name);
  const file = await handle.getFile();
  const buffer: ArrayBuffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function writeUpdateFile(
  root: UpdateDirectory,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const { directory, name } = await parent(root, path, true);
  const stream = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    await stream.abort().catch((): void => {});
    throw error;
  }
}

async function removeUpdateFile(root: UpdateDirectory, path: string): Promise<void> {
  try {
    const { directory, name } = await parent(root, path);
    await directory.removeEntry(name);
  } catch (error) {
    if ((error as { name?: string }).name !== "NotFoundError") {
      throw error;
    }
  }
}

async function fileNames(root: UpdateDirectory, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, entry] of root.entries()) {
    const path = validatePath(prefix + name);
    if (entry.kind === "directory") {
      names.push(...(await fileNames(await root.getDirectoryHandle(name), path + "/")));
    } else if (path !== INSTALLED_FILE) {
      names.push(path);
    }
  }
  return names.sort();
}

export async function verifyDirectory(
  root: UpdateDirectory,
  inventory: UpdateInventory,
): Promise<void> {
  if (
    JSON.stringify(await fileNames(root)) !== JSON.stringify(Object.keys(inventory.files).sort())
  ) {
    throw new Error(
      "The installation contains missing or untracked files. Reconnect a clean release folder.",
    );
  }
  for (const [name, expected] of Object.entries(inventory.files)) {
    await verifyDigest(await readUpdateFile(root, name), expected);
  }
}

export async function unpackUpdate(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  validateZip(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const result = new Map<string, Uint8Array>();
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) {
      result.set(validatePath(entry.name), await entry.async("uint8array"));
    }
  }
  return result;
}

/** Changes to privileges and execution policy require a deliberate new manual installation. */
export function verifyManifestChange(
  base: Record<string, unknown>,
  target: Record<string, unknown>,
  version: string,
): void {
  if (target.version !== version || target.manifest_version !== 3 || target.key !== base.key) {
    throw new Error("The target manifest changes the extension identity or version.");
  }
  for (const key of [
    "permissions",
    "optional_permissions",
    "host_permissions",
    "optional_host_permissions",
    "content_security_policy",
    "sandbox",
    "background",
    "externally_connectable",
  ]) {
    const normalize = (value: unknown) =>
      JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
    if (normalize(base[key]) !== normalize(target[key])) {
      throw new Error(
        `The update changes ${key}; install it manually after reviewing its permissions.`,
      );
    }
  }
}

export async function rollbackUpdate(
  root: UpdateDirectory,
  journal: UpdateJournal,
  saveJournal: (value: UpdateJournal | null) => Promise<void>,
): Promise<void> {
  const baseline = validateInventory(
    JSON.parse(new TextDecoder().decode(journal.baseline)),
    JSON.parse(new TextDecoder().decode(journal.baseline)),
  );
  for (const item of journal.backup) {
    if (item.bytes == null) {
      await removeUpdateFile(root, item.path);
    } else {
      await writeUpdateFile(root, item.path, item.bytes);
    }
  }
  await writeUpdateFile(root, INSTALLED_FILE, journal.baseline);
  await verifyDirectory(root, baseline);
  await saveJournal(null);
}

export async function applyUpdateFiles(
  root: UpdateDirectory,
  baselineBytes: Uint8Array,
  targetBytes: Uint8Array,
  payload: Map<string, Uint8Array>,
  saveJournal: (value: UpdateJournal | null) => Promise<void>,
): Promise<UpdateJournal> {
  const baseline = JSON.parse(new TextDecoder().decode(baselineBytes)) as UpdateInventory;
  validateInventory(baseline, baseline);
  const target = validateInventory(JSON.parse(new TextDecoder().decode(targetBytes)), baseline);
  if (compareVersions(target.version, baseline.version) <= 0) {
    throw new Error("An update must increase the installed version.");
  }
  if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") {
    throw new Error("Reconnect the installation folder and allow write access.");
  }
  await verifyDirectory(root, baseline);
  const changes = fileChanges(baseline, target);
  for (const path of changes.write) {
    const bytes = payload.get(path);
    if (!bytes) {
      throw new Error(`Update payload is missing ${path}.`);
    }
    await verifyDigest(bytes, target.files[path]);
  }
  for (const [path, bytes] of payload) {
    if (path === INSTALLED_FILE) {
      if (new TextDecoder().decode(bytes) !== new TextDecoder().decode(targetBytes)) {
        throw new Error(
          "The full archive's installed inventory does not match the target inventory.",
        );
      }
    } else if (!hasOwn(target.files, path)) {
      throw new Error(`Unexpected update file: ${path}.`);
    } else {
      await verifyDigest(bytes, target.files[path]);
    }
  }
  const oldManifest = JSON.parse(
    new TextDecoder().decode(await readUpdateFile(root, "manifest.json")),
  );
  const newManifestBytes = payload.get("manifest.json");
  if (!newManifestBytes) {
    throw new Error("The update must include its new manifest.");
  }
  verifyManifestChange(
    oldManifest,
    JSON.parse(new TextDecoder().decode(newManifestBytes)),
    target.version,
  );
  const targetConfig = payload.get(CONFIG_FILE);
  if (targetConfig) {
    const oldConfig = JSON.parse(new TextDecoder().decode(await readUpdateFile(root, CONFIG_FILE)));
    const newConfig = JSON.parse(new TextDecoder().decode(targetConfig));
    for (const key of ["repository", "productId", "channel", "flavor", "tagPrefix"]) {
      if (newConfig[key] !== oldConfig[key]) {
        throw new Error("Update source changed; connect the new repository manually.");
      }
    }
  }
  const journal: UpdateJournal = {
    phase: "applying",
    fromVersion: baseline.version,
    toVersion: target.version,
    baseline: baselineBytes,
    target: targetBytes,
    backup: await Promise.all(
      [...changes.write, ...changes.delete].map(async (path) => ({
        path,
        bytes: hasOwn(baseline.files, path) ? await readUpdateFile(root, path) : null,
      })),
    ),
  };
  // This durable record must finish before the first filesystem mutation.
  await saveJournal(journal);
  try {
    const writes = changes.write.filter((path) => path !== "manifest.json").concat("manifest.json");
    for (const path of writes) {
      await writeUpdateFile(root, path, payload.get(path)!);
    }
    for (const path of changes.delete) {
      await removeUpdateFile(root, path);
    }
    await verifyDirectory(root, target);
    await writeUpdateFile(root, INSTALLED_FILE, targetBytes);
    journal.phase = "pendingReload";
    await saveJournal(journal);
    return journal;
  } catch (error) {
    await rollbackUpdate(root, journal, saveJournal);
    throw error;
  }
}
