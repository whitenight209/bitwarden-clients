import {
  MAX_BYTES,
  UpdateConfig,
  UpdateRelease,
  compareVersions,
  validateRelease,
  verifyDigest,
} from "./update-contract";

export type GitHubAsset = { name: string; browser_download_url: string };
export type RemoteUpdate = { release: UpdateRelease; assets: GitHubAsset[] };
export type FetchUpdate = typeof fetch;

export async function downloadUpdate(
  url: string,
  maximum = MAX_BYTES,
  request: FetchUpdate = fetch,
): Promise<Uint8Array> {
  const response = await request(url, {
    credentials: "omit",
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Update download failed (${response.status}).`);
  }
  const declared = response.headers.get("content-length");
  if (declared != null && Number(declared) > maximum) {
    throw new Error("Update download exceeds the size limit.");
  }
  if (!response.body) {
    throw new Error("Empty update response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Update download exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function updateAssetUrl(
  config: UpdateConfig,
  tag: string,
  assets: GitHubAsset[],
  name: string,
): string {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    throw new Error(`Missing or duplicate release asset: ${name}.`);
  }
  const url = new URL(matches[0].browser_download_url);
  const prefix = `/${config.repository}/releases/download/${encodeURIComponent(tag)}/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.pathname !== prefix + name ||
    url.search ||
    url.hash
  ) {
    throw new Error("The asset is not hosted in the configured release.");
  }
  return url.href;
}

export async function findRemoteUpdate(
  config: UpdateConfig,
  currentVersion: string,
  request: FetchUpdate = fetch,
): Promise<RemoteUpdate | null> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
    !/^[a-zA-Z0-9_-]+$/.test(config.tagPrefix)
  ) {
    throw new Error("Invalid release source configuration.");
  }
  const candidates: Array<{ tag_name: string; assets: GitHubAsset[]; version: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const bytes = await downloadUpdate(
      `https://api.github.com/repos/${config.repository}/releases?per_page=100&page=${page}`,
      4 * 1024 * 1024,
      request,
    );
    const entries: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(entries)) {
      throw new Error("Invalid GitHub release response.");
    }
    for (const entry of entries) {
      if (
        entry?.draft !== false ||
        entry?.prerelease !== false ||
        typeof entry.tag_name !== "string" ||
        !entry.tag_name.startsWith(config.tagPrefix) ||
        !Array.isArray(entry.assets)
      ) {
        continue;
      }
      const version = entry.tag_name.slice(config.tagPrefix.length);
      try {
        if (
          compareVersions(version, currentVersion) > 0 &&
          entry.assets.some((asset: GitHubAsset) => asset.name === "update-release.json")
        ) {
          candidates.push({ ...entry, version });
        }
      } catch {
        // Other products and malformed tag names are not update candidates.
      }
    }
    if (entries.length < 100) {
      break;
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }
  const url = (name: string) => updateAssetUrl(config, candidate.tag_name, candidate.assets, name);
  const bytes = await downloadUpdate(url("update-release.json"), 128 * 1024, request);
  const release = validateRelease(JSON.parse(new TextDecoder().decode(bytes)), config);
  if (release.releaseTag !== candidate.tag_name || release.version !== candidate.version) {
    throw new Error("The metadata version does not match the release tag.");
  }
  return { release, assets: candidate.assets };
}

export async function fetchUpdateAsset(
  config: UpdateConfig,
  update: RemoteUpdate,
  asset: { name: string; size: number; sha256: string },
  request: FetchUpdate = fetch,
): Promise<Uint8Array> {
  const bytes = await downloadUpdate(
    updateAssetUrl(config, update.release.releaseTag, update.assets, asset.name),
    asset.size,
    request,
  );
  await verifyDigest(bytes, asset);
  return bytes;
}
