#!/usr/bin/env node
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";

import {
  INSTALLED_FILE,
  compareVersions,
  fileChanges,
  sha256,
  validateInventory,
  validateRelease,
  validateZip,
  verifyDigest,
} from "../src/platform/updates/update-contract.ts";

import { filesIn, releaseConfig } from "./package-custom-update.mjs";

export async function unzip(bytes) {
  validateZip(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const files = new Map();
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) {
      files.set(entry.name, await entry.async("uint8array"));
    }
  }
  return files;
}

async function assertFiles(files, inventory) {
  const names = [...files.keys()].filter((name) => name !== INSTALLED_FILE).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(inventory.files).sort())) {
    throw new Error("Reconstructed release has missing or unexpected files.");
  }
  for (const [name, expected] of Object.entries(inventory.files)) {
    await verifyDigest(files.get(name), expected);
  }
}

export async function verifyReleaseDirectory({ releaseDir, config, baseDir, extractTo }) {
  const bytes = new Uint8Array(await readFile(join(releaseDir, "update-release.json")));
  const release = validateRelease(JSON.parse(new TextDecoder().decode(bytes)), config);
  const asset = async (info) => {
    const data = new Uint8Array(await readFile(join(releaseDir, info.name)));
    await verifyDigest(data, info);
    return data;
  };
  const inventoryBytes = await asset(release.inventory);
  const inventory = validateInventory(JSON.parse(new TextDecoder().decode(inventoryBytes)), config);
  if (inventory.version !== release.version || inventory.commit !== release.commit) {
    throw new Error("Inventory and release metadata disagree.");
  }
  const full = await unzip(await asset(release.full));
  await assertFiles(full, inventory);
  if (
    !full.has(INSTALLED_FILE) ||
    (await sha256(full.get(INSTALLED_FILE))) !== release.inventory.sha256
  ) {
    throw new Error("Full ZIP has an incorrect installation marker.");
  }
  const manifest = JSON.parse(new TextDecoder().decode(full.get("manifest.json")));
  if (manifest.version !== release.version || manifest.manifest_version !== 3) {
    throw new Error("The packaged manifest has an incorrect version.");
  }
  for (const delta of release.deltas) {
    const plan = JSON.parse(new TextDecoder().decode(await asset(delta.plan)));
    const patch = await unzip(await asset(delta.payload));
    if (
      plan.schemaVersion !== 1 ||
      plan.fromVersion !== delta.fromVersion ||
      plan.toVersion !== inventory.version ||
      plan.fromInventorySha256 !== delta.fromInventorySha256 ||
      plan.toInventorySha256 !== release.inventory.sha256 ||
      !Array.isArray(plan.write) ||
      !Array.isArray(plan.delete) ||
      JSON.stringify([...patch.keys()].sort()) !== JSON.stringify([...plan.write].sort())
    ) {
      throw new Error("Invalid patch plan.");
    }
    for (const [name, data] of patch) {
      if (!Object.hasOwn(inventory.files, name)) {
        throw new Error("Unexpected patch file.");
      }
      await verifyDigest(data, inventory.files[name]);
    }
    if (baseDir) {
      const baseBytes = new Uint8Array(await readFile(join(baseDir, INSTALLED_FILE)));
      if ((await sha256(baseBytes)) !== delta.fromInventorySha256) {
        throw new Error("Patch baseline does not match.");
      }
      const baseline = validateInventory(JSON.parse(new TextDecoder().decode(baseBytes)), config);
      const files = await filesIn(baseDir);
      await assertFiles(files, baseline);
      const changes = fileChanges(baseline, inventory);
      if (
        JSON.stringify(plan.write) !== JSON.stringify(changes.write) ||
        JSON.stringify(plan.delete) !== JSON.stringify(changes.delete)
      ) {
        throw new Error("Patch operations do not match the actual build difference.");
      }
      for (const name of plan.delete) {
        files.delete(name);
      }
      for (const [name, data] of patch) {
        files.set(name, data);
      }
      await assertFiles(files, inventory);
    }
  }
  if (extractTo) {
    await mkdir(extractTo, { recursive: true });
    if ((await readdir(extractTo)).length) {
      throw new Error("Baseline extraction directory must be empty.");
    }
    for (const [name, data] of full) {
      const file = join(extractTo, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data, { flag: "wx" });
    }
  }
  return release;
}

/** Downloads a verified patch baseline or reuses the exact published version for CI. */
export async function preparePreviousRelease({
  config,
  version,
  directory,
  token,
  reuseCurrent = false,
}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${config.repository}/releases?per_page=100&page=${page}`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`Could not read previous releases (${response.status}).`);
    }
    const entries = await response.json();
    if (!Array.isArray(entries)) {
      throw new Error("Invalid GitHub release list.");
    }
    for (const entry of entries) {
      if (!entry.draft && !entry.prerelease && entry.tag_name?.startsWith(config.tagPrefix)) {
        const candidate = entry.tag_name.slice(config.tagPrefix.length);
        const comparison = compareVersions(candidate, version);
        if (comparison > 0 || (comparison === 0 && !reuseCurrent)) {
          throw new Error("A release with this version or a newer version is already published.");
        }
        if (!reuseCurrent || candidate === version) {
          releases.push({ ...entry, version: candidate });
        }
      }
    }
    if (entries.length < 100) {
      break;
    }
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  const previous = releases[0];
  if (!previous) {
    if (reuseCurrent) {
      throw new Error("The selected published release was not found.");
    }
    return false;
  }
  const assetDir = join(directory, "assets");
  await mkdir(assetDir, { recursive: true });
  const get = async (name, limit) => {
    const matches = previous.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) {
      throw new Error(`Previous release is incomplete: ${name}.`);
    }
    // The authenticated API endpoint supports private repositories in CI too.
    const response = await fetch(matches[0].url, {
      headers: { ...headers, Accept: "application/octet-stream" },
    });
    if (!response.ok) {
      throw new Error(`Could not download baseline asset (${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new Error("Baseline asset exceeds its limit.");
    }
    await writeFile(join(assetDir, name), bytes, { flag: "wx" });
    return bytes;
  };
  const bytes = await get("update-release.json", 128 * 1024);
  const metadata = validateRelease(JSON.parse(new TextDecoder().decode(bytes)), config);
  if (metadata.releaseTag !== previous.tag_name) {
    throw new Error("Previous release tag and metadata version disagree.");
  }
  for (const info of [
    metadata.inventory,
    metadata.full,
    ...metadata.deltas.flatMap((item) => [item.payload, item.plan]),
  ]) {
    await verifyDigest(await get(info.name, info.size), info);
  }
  await verifyReleaseDirectory({
    releaseDir: assetDir,
    config,
    extractTo: join(directory, "build"),
  });
  return true;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const arg = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Missing ${name}.`);
    }
    return args[index + 1];
  };
  if (command === "prepare") {
    const config = releaseConfig({
      repository: process.env.GITHUB_REPOSITORY,
    });
    const found = await preparePreviousRelease({
      config,
      version: arg("--version"),
      directory: resolve(arg("--out")),
      token: process.env.GH_TOKEN,
      reuseCurrent: args.includes("--reuse-current"),
    });
    console.log(found ? "Verified release downloaded." : "First release: no delta baseline.");
  } else if (command === "verify") {
    const config = JSON.parse(await readFile(resolve(arg("--config")), "utf8"));
    const release = await verifyReleaseDirectory({
      releaseDir: resolve(arg("--release")),
      config,
      baseDir: args.includes("--base") ? resolve(arg("--base")) : undefined,
    });
    console.log(`Verified ${release.releaseTag}.`);
  } else {
    throw new Error(
      "Usage: verify-custom-update.mjs prepare --version VERSION --out DIR [--reuse-current] | verify --release DIR --config FILE [--base DIR]",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
