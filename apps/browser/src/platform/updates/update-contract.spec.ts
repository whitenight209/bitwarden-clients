import { webcrypto } from "node:crypto";

import JSZip from "jszip";

import {
  UpdateInventory,
  compareVersions,
  fileChanges,
  nextReleaseVersion,
  sha256,
  validateInventory,
  validatePath,
  validateZip,
  verifyDigest,
  versionParts,
} from "./update-contract";

beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }),
);

const identity = {
  productId: "custom",
  browser: "chrome" as const,
  flavor: "oss",
  channel: "stable",
};
function inventory(): UpdateInventory {
  return {
    ...identity,
    schemaVersion: 1,
    version: "1.0.0.1",
    commit: "abc",
    files: {
      "manifest.json": { size: 10, sha256: "0".repeat(64) },
      "old.js": { size: 5, sha256: "1".repeat(64) },
    },
  };
}

describe("numeric Chrome versions", () => {
  test.each([
    ["2026.11.0", [], "2026.11.0.1"],
    ["2026.11.0", ["2026.11.0.9", "2026.11.0.10"], "2026.11.0.11"],
    ["2026.12.0", ["2026.11.0.50"], "2026.12.0.1"],
    ["2026.11.0", ["desktop-v1", "invalid", "2026.11.0.2"], "2026.11.0.3"],
    ["2026.11.0.65535", [], "2026.11.1.0"],
  ])("CI increments %s past published versions %j", (base, published, expected) => {
    expect(nextReleaseVersion(base as string, published as string[])).toBe(expected);
  });
  test("rejects an exhausted Chrome version range", () => {
    expect(() => nextReleaseVersion("65535.65535.65535.65535", [])).toThrow(/higher/);
  });
  test.each([
    ["1.0.0.10", "1.0.0.9", 1],
    ["2", "1.65535.65535.65535", 1],
    ["1.2", "1.2.0.0", 0],
    ["2026.11.0.1", "2026.11.0.2", -1],
  ])("compares %s with %s numerically", (a, b, expected) =>
    expect(compareVersions(a as string, b as string)).toBe(expected),
  );
  test.each(["0", "0.0", "01.0", "1.2.3.4.5", "1.65536", "-1", "1.0-beta", "1.", "NaN"])(
    "rejects %s",
    (version) => expect(() => versionParts(version)).toThrow(),
  );
});

describe("filesystem boundary", () => {
  test.each([
    "../escape",
    "/absolute",
    "a/../b",
    "a//b",
    "a\\b",
    "a\0b",
    "C:/drive",
    "a/.",
    "a/CON.txt",
    "a/file.",
    "a/file ",
  ])("rejects unsafe path %s", (path) => expect(() => validatePath(path)).toThrow());
  test.each([
    "manifest.json",
    "popup/index.html",
    "assets/file.hash.wasm",
    "_locales/ko/messages.json",
  ])("accepts build path %s", (path) => expect(validatePath(path)).toBe(path));
});

describe("inventory and changes", () => {
  test.each(["productId", "browser", "flavor", "channel"] as const)(
    "rejects a foreign %s",
    (field) => {
      expect(() => validateInventory({ ...inventory(), [field]: "other" }, identity)).toThrow();
    },
  );
  test("requires a manifest", () => {
    const value = inventory();
    delete value.files["manifest.json"];
    expect(() => validateInventory(value, identity)).toThrow();
  });
  test("rejects case collisions on case-insensitive filesystems", () => {
    const value = inventory();
    value.files["MANIFEST.json"] = value.files["manifest.json"];
    expect(() => validateInventory(value, identity)).toThrow();
  });
  test("rejects installation metadata recursively hashing itself", () => {
    const value = inventory();
    value.files["custom-update-installed.json"] = value.files["manifest.json"];
    expect(() => validateInventory(value, identity)).toThrow();
  });
  test("rejects an oversized or negative file length", () => {
    const value = inventory();
    value.files["old.js"].size = -1;
    expect(() => validateInventory(value, identity)).toThrow();
    value.files["old.js"].size = 257 * 1024 * 1024;
    expect(() => validateInventory(value, identity)).toThrow();
  });
  test("handles added, modified, identical and deleted binary files", () => {
    const base = inventory(),
      target = inventory();
    target.files["new.wasm"] = target.files["old.js"];
    delete target.files["old.js"];
    target.files["manifest.json"] = { size: 11, sha256: "2".repeat(64) };
    expect(fileChanges(base, target)).toEqual({
      write: ["manifest.json", "new.wasm"],
      delete: ["old.js"],
    });
  });
});

describe("release integrity", () => {
  test("verifies exact byte length and SHA-256", async () => {
    const bytes = new TextEncoder().encode("release");
    const expected = { size: bytes.length, sha256: await sha256(bytes) };
    await expect(verifyDigest(bytes, expected)).resolves.toBeUndefined();
    await expect(verifyDigest(bytes, { ...expected, size: bytes.length + 1 })).rejects.toThrow();
    await expect(verifyDigest(new TextEncoder().encode("releasE"), expected)).rejects.toThrow();
  });
  test("accepts a normal ZIP and rejects traversal before JSZip sanitizes it", async () => {
    const normal = new JSZip();
    normal.file("popup/index.html", "ok", { createFolders: false });
    const bytes = await normal.generateAsync({ type: "uint8array" });
    expect(() => validateZip(bytes)).not.toThrow();
    const malicious = new JSZip();
    malicious.file("../escape.js", "bad", { createFolders: false });
    const unsafe = await malicious.generateAsync({ type: "uint8array" });
    expect(() => validateZip(unsafe)).toThrow();
    expect(() => validateZip(bytes.subarray(0, bytes.length - 1))).toThrow();
  });
  test("rejects symlinks and duplicate case-normalized ZIP entries", async () => {
    const links = new JSZip();
    links.file("link", "target", { unixPermissions: 0o120777 });
    const linkBytes = await links.generateAsync({ type: "uint8array", platform: "UNIX" });
    expect(() => validateZip(linkBytes)).toThrow();
    const collision = new JSZip();
    collision.file("main.js", "a");
    collision.file("MAIN.js", "b");
    const bytes = await collision.generateAsync({ type: "uint8array" });
    expect(() => validateZip(bytes)).toThrow();
  });
});
