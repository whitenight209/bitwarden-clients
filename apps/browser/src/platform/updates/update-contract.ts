/** Dependency-free release contract shared by CI and the browser updater. */
export const UPDATE_PROTOCOL = 1;
export const INSTALLED_FILE = "custom-update-installed.json";
export const CONFIG_FILE = "custom-update-config.json";
export const MAX_FILES = 20_000;
export const MAX_BYTES = 256 * 1024 * 1024;

export type FileDigest = { size: number; sha256: string };
export type UpdateIdentity = {
  productId: string;
  browser: "chrome";
  flavor: string;
  channel: string;
};
export type UpdateInventory = UpdateIdentity & {
  schemaVersion: 1;
  version: string;
  commit: string;
  files: Record<string, FileDigest>;
};
export type UpdateAsset = FileDigest & { name: string };
export type UpdateDelta = {
  fromVersion: string;
  fromInventorySha256: string;
  payload: UpdateAsset;
  plan: UpdateAsset;
};
export type UpdateRelease = UpdateIdentity & {
  schemaVersion: 1;
  version: string;
  commit: string;
  releaseTag: string;
  minimumChromeVersion: string;
  minimumUpdaterProtocol: number;
  inventory: UpdateAsset;
  full: UpdateAsset;
  deltas: UpdateDelta[];
};
export type UpdatePlan = {
  schemaVersion: 1;
  fromVersion: string;
  toVersion: string;
  fromInventorySha256: string;
  toInventorySha256: string;
  write: string[];
  delete: string[];
};
export type UpdateConfig = UpdateIdentity & {
  schemaVersion: 1;
  repository: string;
  tagPrefix: string;
};

export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) {
    throw new Error("Invalid Chrome extension version.");
  }
  const parts = version.split(".").map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) {
    throw new Error("Chrome version components must be between 0 and 65535.");
  }
  return [...parts, ...Array<number>(4 - parts.length).fill(0)];
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) {
      return Math.sign(a[i] - b[i]);
    }
  }
  return 0;
}

/** CI uses the next numeric version after both the source manifest and published releases. */
export function nextReleaseVersion(base: string, published: string[]): string {
  let highest = base;
  for (const version of published) {
    try {
      if (compareVersions(version, highest) > 0) {
        highest = version;
      }
    } catch {
      // Ignore unrelated or malformed release tags.
    }
  }
  const parts = versionParts(highest);
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] < 65535) {
      parts[index]++;
      return parts.join(".");
    }
    parts[index] = 0;
  }
  throw new Error("No higher Chrome extension version is available.");
}

export function validatePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    path.normalize("NFC") !== path ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in downloaded file paths.
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part),
      )
  ) {
    throw new Error(`Unsafe update path: ${String(path)}`);
  }
  return path;
}

export function isDigest(value: unknown): value is FileDigest {
  const item = value as FileDigest | undefined;
  return (
    !!item &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    item.size <= MAX_BYTES &&
    typeof item.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(item.sha256)
  );
}

export function assertIdentity(value: UpdateIdentity, expected: UpdateIdentity): void {
  for (const key of ["productId", "browser", "flavor", "channel"] as const) {
    if (typeof value?.[key] !== "string" || value[key] !== expected[key]) {
      throw new Error(`Update ${key} does not match this installation.`);
    }
  }
}

export function validateInventory(value: unknown, identity: UpdateIdentity): UpdateInventory {
  const inventory = value as UpdateInventory;
  assertIdentity(inventory, identity);
  if (
    inventory.schemaVersion !== 1 ||
    typeof inventory.commit !== "string" ||
    !inventory.files ||
    typeof inventory.files !== "object" ||
    Array.isArray(inventory.files)
  ) {
    throw new Error("Unsupported file inventory.");
  }
  versionParts(inventory.version);
  const entries = Object.entries(inventory.files);
  if (!entries.length || entries.length > MAX_FILES || !hasOwn(inventory.files, "manifest.json")) {
    throw new Error("The inventory must include a manifest and a bounded number of files.");
  }
  const names = new Set<string>();
  let bytes = 0;
  for (const [path, digest] of entries) {
    validatePath(path);
    const normalized = path.toLowerCase();
    if (names.has(normalized) || normalized === INSTALLED_FILE || !isDigest(digest)) {
      throw new Error("Invalid, reserved, or duplicate inventory entry.");
    }
    names.add(normalized);
    bytes += digest.size;
  }
  if (bytes > MAX_BYTES) {
    throw new Error("The release is too large.");
  }
  return inventory;
}

export function fileChanges(
  base: UpdateInventory,
  target: UpdateInventory,
): { write: string[]; delete: string[] } {
  return {
    write: Object.keys(target.files)
      .filter(
        (path) =>
          !hasOwn(base.files, path) ||
          base.files[path].sha256 !== target.files[path].sha256 ||
          base.files[path].size !== target.files[path].size,
      )
      .sort(),
    delete: Object.keys(base.files)
      .filter((path) => !hasOwn(target.files, path))
      .sort(),
  };
}

export function validateRelease(value: unknown, config: UpdateConfig): UpdateRelease {
  const release = value as UpdateRelease;
  assertIdentity(release, config);
  if (
    release.schemaVersion !== 1 ||
    !Number.isInteger(release.minimumUpdaterProtocol) ||
    release.minimumUpdaterProtocol < 1 ||
    release.minimumUpdaterProtocol > UPDATE_PROTOCOL ||
    typeof release.commit !== "string" ||
    release.releaseTag !== config.tagPrefix + release.version ||
    !Array.isArray(release.deltas) ||
    release.deltas.length > 20
  ) {
    throw new Error("Unsupported release or updater protocol.");
  }
  versionParts(release.version);
  versionParts(release.minimumChromeVersion);
  const asset = (item: UpdateAsset) => {
    if (
      !isDigest(item) ||
      typeof item.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(item.name)
    ) {
      throw new Error("Invalid release asset.");
    }
  };
  asset(release.inventory);
  asset(release.full);
  for (const delta of release.deltas) {
    versionParts(delta.fromVersion);
    if (
      !/^[a-f0-9]{64}$/.test(delta.fromInventorySha256) ||
      compareVersions(delta.fromVersion, release.version) >= 0
    ) {
      throw new Error("Invalid delta baseline.");
    }
    asset(delta.payload);
    asset(delta.plan);
  }
  return release;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
}

export async function verifyDigest(bytes: Uint8Array, expected: FileDigest): Promise<void> {
  if (
    !isDigest(expected) ||
    bytes.byteLength !== expected.size ||
    (await sha256(bytes)) !== expected.sha256
  ) {
    throw new Error("Update integrity verification failed.");
  }
}

/** Inspect central-directory names before JSZip can normalize traversal or discard duplicates. */
export function validateZip(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BYTES || bytes.byteLength < 22) {
    throw new Error("Invalid archive size.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  const minimum = Math.max(0, end - 65535);
  for (; end >= minimum; end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    ) {
      break;
    }
  }
  if (end < minimum || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new Error("Unsupported ZIP archive.");
  }
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    count > MAX_FILES * 2 ||
    offset + centralSize !== end ||
    view.getUint16(end + 8, true) !== count
  ) {
    throw new Error("Unsupported ZIP directory.");
  }
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP directory entry.");
    }
    const length = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comment = view.getUint16(offset + 32, true);
    if (offset + 46 + length + extra + comment > end || view.getUint16(offset + 8, true) & 1) {
      throw new Error("Invalid or encrypted ZIP entry.");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + length),
    );
    validatePath(name.endsWith("/") ? name.slice(0, -1) : name);
    const normalized = name.toLowerCase();
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if (names.has(normalized) || (mode & 0xf000) === 0xa000) {
      throw new Error("Duplicate or symbolic-link ZIP entry.");
    }
    names.add(normalized);
    total += view.getUint32(offset + 24, true);
    if (total > MAX_BYTES) {
      throw new Error("Archive exceeds the unpacked size limit.");
    }
    offset += 46 + length + extra + comment;
  }
  if (offset !== end) {
    throw new Error("Invalid ZIP directory length.");
  }
}
