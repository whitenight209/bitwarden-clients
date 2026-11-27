import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packageUpdate } from "./package-custom-update.mjs";
import { unzip, verifyReleaseDirectory } from "./verify-custom-update.mjs";

async function fixture(t, version = "2026.11.0.1") {
  const root = await mkdtemp(join(tmpdir(), "custom-update-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buildDir = join(root, "build");
  await mkdir(join(buildDir, "popup"), { recursive: true });
  await writeFile(
    join(buildDir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version: "2026.11.0",
      minimum_chrome_version: "134.0",
      permissions: ["storage", "sidePanel"],
      background: { service_worker: "background.js" },
    }),
  );
  await writeFile(join(buildDir, "background.js"), "console.log('old');");
  await writeFile(join(buildDir, "popup", "index.html"), "<!doctype html><title>Test</title>");
  return {
    root,
    buildDir,
    outDir: join(root, "release"),
    version,
    repository: "owner/custom",
    commit: "abc123",
  };
}

test("first release needs no keys, is installable at ZIP root, and has no delta", async (t) => {
  const options = await fixture(t);
  const result = await packageUpdate(options);
  assert.equal(result.release.deltas.length, 0);
  assert.equal(result.config.publicKey, undefined);
  await assert.rejects(readFile(join(options.outDir, "update-release.json.sig")), {
    code: "ENOENT",
  });
  assert.equal(result.inventory.files["custom-update-installed.json"], undefined);
  const release = await verifyReleaseDirectory({
    releaseDir: options.outDir,
    config: result.config,
    extractTo: join(options.root, "installed"),
  });
  const manifest = JSON.parse(await readFile(join(options.root, "installed/manifest.json")));
  assert.equal(manifest.version, release.version);
  assert.equal(manifest.key, undefined);
});

test("CI delta includes only changed/new files and reconstructs the entire target including deletion", async (t) => {
  const base = await fixture(t);
  await writeFile(join(base.buildDir, "old.css"), "obsolete");
  await packageUpdate(base);
  const target = await fixture(t, "2026.11.0.2");
  await writeFile(join(target.buildDir, "background.js"), "console.log('new');");
  await writeFile(join(target.buildDir, "new.wasm"), new Uint8Array([0, 97, 115, 109]));
  target.baseDir = base.buildDir;
  const result = await packageUpdate(target);
  assert.equal(result.release.deltas.length, 1);
  const delta = result.release.deltas[0];
  const files = await unzip(
    new Uint8Array(await readFile(join(target.outDir, delta.payload.name))),
  );
  assert.deepEqual([...files.keys()].sort(), ["background.js", "manifest.json", "new.wasm"]);
  const plan = JSON.parse(await readFile(join(target.outDir, delta.plan.name)));
  assert.deepEqual(plan.delete, ["old.css"]);
  await verifyReleaseDirectory({
    releaseDir: target.outDir,
    config: result.config,
    baseDir: base.buildDir,
  });
});

test("same runtime files produce deterministic ZIP bytes", async (t) => {
  const left = await fixture(t);
  const right = await fixture(t);
  const a = await packageUpdate(left);
  const b = await packageUpdate(right);
  assert.equal(a.release.full.sha256, b.release.full.sha256);
});

for (const version of ["2026.11.0-beta.1", "2026.11.0.65536", "01.0", "0.0.0.0", "1.2.3.4.5"]) {
  test(`refuses invalid release version ${version}`, async (t) => {
    await assert.rejects(packageUpdate(await fixture(t, version)));
  });
}

test("does not overwrite a release output directory", async (t) => {
  const options = await fixture(t);
  await packageUpdate(options);
  await assert.rejects(packageUpdate(options), /must be empty/);
});

test("rejects symbolic links in the build", async (t) => {
  const options = await fixture(t);
  await symlink(join(options.buildDir, "background.js"), join(options.buildDir, "linked.js"));
  await assert.rejects(packageUpdate(options), /symbolic link/);
});

test("rejects a locally modified baseline", async (t) => {
  const base = await fixture(t);
  await packageUpdate(base);
  await writeFile(join(base.buildDir, "background.js"), "modified locally");
  const target = await fixture(t, "2026.11.0.2");
  await assert.rejects(
    packageUpdate({ ...target, baseDir: base.buildDir }),
    /Baseline file changed/,
  );
});

test("rejects untracked baseline files", async (t) => {
  const base = await fixture(t);
  await packageUpdate(base);
  await writeFile(join(base.buildDir, "untracked.js"), "not in inventory");
  const target = await fixture(t, "2026.11.0.2");
  await assert.rejects(packageUpdate({ ...target, baseDir: base.buildDir }), /untracked/);
});

test("rejects same-version and older releases", async (t) => {
  const base = await fixture(t, "2026.11.0.2");
  await packageUpdate(base);
  const target = await fixture(t, "2026.11.0.1");
  await assert.rejects(packageUpdate({ ...target, baseDir: base.buildDir }), /greater/);
});

test("rejects a patch baseline belonging to another product", async (t) => {
  const base = await fixture(t);
  await packageUpdate(base);
  const path = join(base.buildDir, "custom-update-installed.json");
  const marker = JSON.parse(await readFile(path));
  marker.productId = "different-product";
  await writeFile(path, JSON.stringify(marker));
  const target = await fixture(t, "2026.11.0.2");
  await assert.rejects(packageUpdate({ ...target, baseDir: base.buildDir }), /productId/);
});

test("rejects metadata whose version disagrees with its tag", async (t) => {
  const options = await fixture(t);
  const { config } = await packageUpdate(options);
  const path = join(options.outDir, "update-release.json");
  const metadata = JSON.parse(await readFile(path));
  metadata.version = "2026.11.0.9";
  await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(
    verifyReleaseDirectory({ releaseDir: options.outDir, config }),
    /Unsupported release/,
  );
});

test("rejects a ZIP that disagrees with its file list", async (t) => {
  const options = await fixture(t);
  const { config, release } = await packageUpdate(options);
  await writeFile(join(options.outDir, release.full.name), "tampered");
  await assert.rejects(verifyReleaseDirectory({ releaseDir: options.outDir, config }), /integrity/);
});

test("ignores an unrelated signature asset and uses the version metadata", async (t) => {
  const options = await fixture(t);
  const { config } = await packageUpdate(options);
  await writeFile(join(options.outDir, "update-release.json.sig"), "not-a-signature");
  const release = await verifyReleaseDirectory({ releaseDir: options.outDir, config });
  assert.equal(release.version, options.version);
});

test("preserves an existing manifest identity without key configuration", async (t) => {
  const base = await fixture(t);
  const path = join(base.buildDir, "manifest.json");
  const manifest = JSON.parse(await readFile(path));
  manifest.key = "existing-manifest-identity";
  await writeFile(path, JSON.stringify(manifest));
  await packageUpdate(base);
  const target = await fixture(t, "2026.11.0.2");
  await packageUpdate({ ...target, baseDir: base.buildDir });
  const next = JSON.parse(await readFile(join(target.buildDir, "manifest.json")));
  assert.equal(next.key, manifest.key);
});
