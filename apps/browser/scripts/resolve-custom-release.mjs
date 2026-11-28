import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareVersions,
  nextReleaseVersion,
  versionParts,
} from "../src/platform/updates/update-contract.ts";

const prefix = "browser-custom-v";
const releasePaths = [
  "apps/browser/src",
  "apps/browser/config",
  "apps/browser/webpack",
  ":(glob)apps/browser/webpack*.js",
  "apps/browser/package.json",
  "apps/browser/postcss.config.js",
  "apps/browser/tailwind.config.js",
  "apps/browser/tsconfig.json",
  "apps/browser/tsconfig.build.json",
  "apps/browser/scripts/package-custom-update.mjs",
  "libs",
  "bitwarden_license/bit-common",
  "bitwarden_license/bit-pam",
  "bitwarden_license/bit-pam-components",
  "package.json",
  "package-lock.json",
  ".npmrc",
  ".nvmrc",
  "babel.config.json",
  "tailwind.config.js",
  "tsconfig.base.json",
  "tsconfig.json",
  ":(glob,exclude)**/*.md",
  ":(glob,exclude)**/*.spec.*",
  ":(glob,exclude)**/*.test.*",
  ":(glob,exclude)**/__tests__/**",
  ":(glob,exclude)**/*.stories.*",
];

export function latestPublishedVersion(releases) {
  let latest;
  for (const { tag_name: tag, draft, prerelease } of releases) {
    if (draft || prerelease || !tag?.startsWith(prefix)) {
      continue;
    }
    const version = tag.slice(prefix.length);
    try {
      versionParts(version);
    } catch {
      continue;
    }
    if (!latest || compareVersions(version, latest) > 0) {
      latest = version;
    }
  }
  return latest;
}

export function hasReleaseChanges(baseline, cwd = process.cwd()) {
  const { status, error, stderr } = spawnSync(
    "git",
    ["diff", "--quiet", "--no-ext-diff", baseline, "HEAD", "--", ...releasePaths],
    { cwd, encoding: "utf8" },
  );
  if (status === 0 || status === 1) {
    return status === 1;
  }
  throw error ?? new Error(`Could not compare release inputs: ${stderr}`);
}

export function releaseDecision({ manifestVersion, publishedVersion, changed, requested }) {
  if (!changed) {
    return { version: publishedVersion, changed: false };
  }
  const next = nextReleaseVersion(manifestVersion, publishedVersion ? [publishedVersion] : []);
  if (requested && compareVersions(requested, next) < 0) {
    throw new Error(`The requested version must be at least ${next}.`);
  }
  return { version: requested || next, changed: true };
}

function main() {
  const releases = JSON.parse(readFileSync(process.argv[2], "utf8")).flat();
  const publishedVersion = latestPublishedVersion(releases);
  const manifest = JSON.parse(readFileSync("apps/browser/src/manifest.v3.json", "utf8"));
  let changed = true;
  if (publishedVersion) {
    const ref = `refs/tags/${prefix}${publishedVersion}`;
    const fetch = spawnSync(
      "git",
      [
        "-c",
        "credential.helper=!gh auth git-credential",
        "fetch",
        "--depth=1",
        "--no-tags",
        "origin",
        ref,
      ],
      { stdio: "inherit" },
    );
    if (fetch.status !== 0) {
      throw fetch.error ?? new Error(`Could not fetch the published release tag ${ref}.`);
    }
    changed = hasReleaseChanges("FETCH_HEAD");
  }
  const tagVersion =
    process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME.slice(prefix.length) : "";
  const { version } = releaseDecision({
    manifestVersion: manifest.version,
    publishedVersion,
    changed,
    requested: process.env.INPUT_VERSION || tagVersion,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nchanged=${changed}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    changed
      ? `Building Chrome extension **${version}**.\n`
      : `Chrome extension code is unchanged. Reusing published version **${version}**.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
