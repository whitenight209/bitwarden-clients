#!/usr/bin/env node
import { mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";

import {
  CONFIG_FILE,
  INSTALLED_FILE,
  compareVersions,
  fileChanges,
  sha256,
  validateInventory,
  validatePath,
  versionParts,
} from "../src/platform/updates/update-contract.ts";

export const encodeJson = (value) =>
  new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
export const digest = async (bytes) => ({ size: bytes.length, sha256: await sha256(bytes) });

export function releaseConfig(options) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new Error("The release repository must be OWNER/REPOSITORY.");
  }
  return {
    schemaVersion: 1,
    productId: "bitwarden-custom-browser",
    browser: "chrome",
    flavor: "oss-custom",
    channel: "custom-stable",
    repository: options.repository,
    tagPrefix: "browser-custom-v",
  };
}

export async function filesIn(directory, prefix = "") {
  const result = new Map();
  for (const entry of (await readdir(directory)).sort()) {
    const relative = prefix + entry;
    validatePath(relative);
    const path = join(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Build contains a symbolic link: ${relative}`);
    }
    if (stat.isDirectory()) {
      for (const [name, data] of await filesIn(path, relative + "/")) {
        result.set(name, data);
      }
    } else if (stat.isFile() && relative !== INSTALLED_FILE) {
      result.set(relative, new Uint8Array(await readFile(path)));
    } else if (!stat.isFile()) {
      throw new Error(`Build contains a non-regular file: ${relative}`);
    }
  }
  return result;
}

export async function zipFiles(files) {
  const zip = new JSZip();
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    zip.file(name, bytes, { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export async function packageUpdate(options) {
  versionParts(options.version);
  const config = releaseConfig(options);
  const manifestPath = join(options.buildDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3 || !manifest.background?.service_worker) {
    throw new Error("Only Chrome Manifest V3 builds are supported.");
  }
  manifest.version = options.version;
  // Keep an existing installation identity when building against a previous release.
  if (options.baseDir) {
    const previousManifest = JSON.parse(
      await readFile(join(options.baseDir, "manifest.json"), "utf8"),
    );
    if (previousManifest.key) {
      manifest.key = previousManifest.key;
    }
  }
  delete manifest.version_name;
  await writeFile(manifestPath, encodeJson(manifest));
  await writeFile(join(options.buildDir, CONFIG_FILE), encodeJson(config));
  const files = await filesIn(options.buildDir);
  const inventory = {
    schemaVersion: 1,
    ...Object.fromEntries(
      ["productId", "browser", "flavor", "channel"].map((key) => [key, config[key]]),
    ),
    version: options.version,
    commit: options.commit,
    files: Object.fromEntries(
      await Promise.all([...files].map(async ([name, bytes]) => [name, await digest(bytes)])),
    ),
  };
  validateInventory(inventory, config);
  const inventoryBytes = encodeJson(inventory);
  await writeFile(join(options.buildDir, INSTALLED_FILE), inventoryBytes);
  await mkdir(options.outDir, { recursive: true });
  if ((await readdir(options.outDir)).length) {
    throw new Error("Release output directory must be empty; use a new directory for each build.");
  }
  const asset = async (name, bytes) => {
    await writeFile(join(options.outDir, name), bytes);
    return { name, ...(await digest(bytes)) };
  };
  const inventoryAsset = await asset(`extension-files-${options.version}.json`, inventoryBytes);
  const full = await asset(
    `extension-chrome-custom-${options.version}.zip`,
    await zipFiles(new Map([...files, [INSTALLED_FILE, inventoryBytes]])),
  );
  const deltas = [];
  if (options.baseDir) {
    const baseBytes = new Uint8Array(await readFile(join(options.baseDir, INSTALLED_FILE)));
    const base = validateInventory(JSON.parse(new TextDecoder().decode(baseBytes)), config);
    if (compareVersions(base.version, options.version) >= 0) {
      throw new Error("A release version must be greater than its baseline.");
    }
    const changes = fileChanges(base, inventory);
    const fromInventorySha256 = await sha256(baseBytes);
    const plan = {
      schemaVersion: 1,
      fromVersion: base.version,
      toVersion: options.version,
      fromInventorySha256,
      toInventorySha256: inventoryAsset.sha256,
      ...changes,
    };
    // Verify actual baseline bytes, not merely a possibly stale installed marker.
    const baseFiles = await filesIn(options.baseDir);
    if (baseFiles.size !== Object.keys(base.files).length) {
      throw new Error("Baseline contains untracked runtime files.");
    }
    for (const [name, expected] of Object.entries(base.files)) {
      const bytes = baseFiles.get(name);
      if (!bytes || bytes.length !== expected.size || (await sha256(bytes)) !== expected.sha256) {
        throw new Error(`Baseline file changed: ${name}`);
      }
    }
    deltas.push({
      fromVersion: base.version,
      fromInventorySha256,
      payload: await asset(
        `patch-chrome-custom-${base.version}-to-${options.version}.zip`,
        await zipFiles(new Map(changes.write.map((name) => [name, files.get(name)]))),
      ),
      plan: await asset(`patch-plan-${base.version}-to-${options.version}.json`, encodeJson(plan)),
    });
  }
  const release = {
    schemaVersion: 1,
    ...Object.fromEntries(
      ["productId", "browser", "flavor", "channel"].map((key) => [key, config[key]]),
    ),
    version: options.version,
    commit: options.commit,
    releaseTag: config.tagPrefix + options.version,
    minimumChromeVersion: manifest.minimum_chrome_version ?? "134.0",
    minimumUpdaterProtocol: 1,
    inventory: inventoryAsset,
    full,
    deltas,
  };
  const releaseBytes = encodeJson(release);
  await writeFile(join(options.outDir, "update-release.json"), releaseBytes);
  return { config, inventory, release };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "package") {
    throw new Error(
      "Usage: package-custom-update.mjs package --build DIR --out DIR --version VERSION [--base DIR]",
    );
  }
  const requiredOption = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Missing ${name}.`);
    }
    return args[index + 1];
  };
  const result = await packageUpdate({
    buildDir: resolve(requiredOption("--build")),
    outDir: resolve(requiredOption("--out")),
    version: requiredOption("--version"),
    baseDir: args.includes("--base") ? resolve(requiredOption("--base")) : undefined,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA ?? "local",
  });
  console.log(
    `Packaged ${result.release.releaseTag}: ${Object.keys(result.inventory.files).length} files, ${result.release.deltas.length} delta(s).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
