import { webcrypto } from "node:crypto";
import { runInThisContext } from "node:vm";

import { UpdateConfig, UpdateRelease, sha256 } from "./update-contract";
import {
  downloadUpdate,
  fetchUpdateAsset,
  findRemoteUpdate,
  updateAssetUrl,
} from "./update-source";

beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }),
);

const NativeResponse = runInThisContext("Response") as typeof Response;

const config: UpdateConfig = {
  schemaVersion: 1,
  productId: "custom",
  browser: "chrome",
  flavor: "oss",
  channel: "stable",
  repository: "owner/repo",
  tagPrefix: "browser-custom-v",
};
const file = { name: "extension.zip", size: 1, sha256: "0".repeat(64) };
const url = (tag: string, name: string) =>
  `https://github.com/owner/repo/releases/download/${tag}/${name}`;

function candidate(version: string, changes = {}) {
  const tag = config.tagPrefix + version;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: ["update-release.json", "extension.zip"].map((name) => ({
      name,
      browser_download_url: url(tag, name),
    })),
    ...changes,
  };
}

function fixture(versions = ["1.0.0.2"]) {
  const entries = versions.map((version) => candidate(version));
  const responses = new Map<string, Uint8Array>();
  for (const version of versions) {
    const release: UpdateRelease = {
      ...config,
      schemaVersion: 1,
      version,
      commit: "abc",
      releaseTag: config.tagPrefix + version,
      minimumChromeVersion: "134.0",
      minimumUpdaterProtocol: 1,
      inventory: { ...file, name: "files.json" },
      full: file,
      deltas: [],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(release));
    responses.set(url(release.releaseTag, "update-release.json"), bytes);
  }
  const request = jest.fn(async (input: RequestInfo | URL) => {
    const address = String(input);
    if (address.startsWith("https://api.github.com/")) {
      return new NativeResponse(JSON.stringify(entries));
    }
    const bytes = responses.get(address);
    return bytes
      ? new NativeResponse(bytes as unknown as BodyInit)
      : new NativeResponse("missing", { status: 404 });
  }) as jest.MockedFunction<typeof fetch>;
  return { entries, responses, request };
}

test("selects the highest numeric version instead of the first release or lexical order", async () => {
  const f = fixture(["1.0.0.9", "1.0.0.10"]);
  const result = await findRemoteUpdate(config, "1.0.0.1", f.request);
  expect(result?.release.version).toBe("1.0.0.10");
});

test("ignores drafts, prereleases, other products and current versions", async () => {
  const f = fixture();
  f.entries[0].draft = true;
  f.entries.push(
    candidate("1.0.0.3", { prerelease: true }),
    candidate("1.0.0.4", { tag_name: "desktop-v1.0.0.4" }),
    candidate("1.0.0.1"),
  );
  expect(await findRemoteUpdate(config, "1.0.0.1", f.request)).toBeNull();
});

test("accepts a newer release without a signature asset or verification keys", async () => {
  const f = fixture(["1.0.0.2", "1.0.0.3"]);
  const result = await findRemoteUpdate(config, "1.0.0.1", f.request);
  expect(result?.release.version).toBe("1.0.0.3");
  expect(f.request.mock.calls.every(([address]) => !String(address).endsWith(".sig"))).toBe(true);
});

test("refuses metadata whose version disagrees with its release tag", async () => {
  const f = fixture();
  const address = url("browser-custom-v1.0.0.2", "update-release.json");
  const metadata = JSON.parse(new TextDecoder().decode(f.responses.get(address)));
  metadata.version = "1.0.0.3";
  metadata.releaseTag = "browser-custom-v1.0.0.3";
  f.responses.set(address, new TextEncoder().encode(JSON.stringify(metadata)));
  await expect(findRemoteUpdate(config, "1.0.0.1", f.request)).rejects.toThrow(/version/);
});

test.each([
  "http://github.com/owner/repo/releases/download/v1/a.zip",
  "https://evil.example/a.zip",
  "https://github.com/other/repo/releases/download/v1/a.zip",
  "https://github.com/owner/repo/releases/download/v2/a.zip",
])("rejects a foreign download URL %s", (address) => {
  expect(() =>
    updateAssetUrl(config, "v1", [{ name: "a.zip", browser_download_url: address }], "a.zip"),
  ).toThrow();
});

test("rejects duplicate or missing assets", () => {
  expect(() => updateAssetUrl(config, "v1", [], "a.zip")).toThrow();
  const asset = { name: "a.zip", browser_download_url: url("v1", "a.zip") };
  expect(() => updateAssetUrl(config, "v1", [asset, asset], "a.zip")).toThrow();
});

test("a file digest is checked after download", async () => {
  const f = fixture();
  const remote = (await findRemoteUpdate(config, "1.0.0.1", f.request))!;
  const bytes = new TextEncoder().encode("release bytes");
  f.responses.set(url(remote.release.releaseTag, "extension.zip"), bytes);
  const asset = { name: "extension.zip", size: bytes.length, sha256: await sha256(bytes) };
  await expect(fetchUpdateAsset(config, remote, asset, f.request)).resolves.toEqual(bytes);
  await expect(
    fetchUpdateAsset(config, remote, { ...asset, sha256: "0".repeat(64) }, f.request),
  ).rejects.toThrow(/integrity/);
});

test("rejects failed responses and oversized declared or streamed bodies", async () => {
  await expect(
    downloadUpdate(
      "https://example.test",
      10,
      async () => new NativeResponse("no", { status: 429 }),
    ),
  ).rejects.toThrow("429");
  await expect(
    downloadUpdate(
      "https://example.test",
      10,
      async () => new NativeResponse("small", { headers: { "content-length": "100" } }),
    ),
  ).rejects.toThrow(/size/);
  await expect(
    downloadUpdate("https://example.test", 2, async () => new NativeResponse("too large")),
  ).rejects.toThrow(/size/);
});
