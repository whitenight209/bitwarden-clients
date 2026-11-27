import { webcrypto } from "node:crypto";

import type { CustomUpdateAgent as Agent } from "./custom-update-agent";

jest.mock("./update-store", () => ({
  getUpdateState: jest.fn(),
  setUpdateState: jest.fn(),
  finishUpdate: jest.fn(),
}));
jest.mock("./update-source", () => ({ findRemoteUpdate: jest.fn(), fetchUpdateAsset: jest.fn() }));
jest.mock("./update-files", () => ({
  ...jest.requireActual("./update-files"),
  applyUpdateFiles: jest.fn(),
  readUpdateFile: jest.fn(),
  unpackUpdate: jest.fn(),
  verifyDirectory: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const config = {
  schemaVersion: 1,
  productId: "custom",
  browser: "chrome",
  flavor: "oss",
  channel: "stable",
  repository: "owner/repo",
  tagPrefix: "browser-custom-v",
};
const inventory = (version: string) => ({
  ...config,
  version,
  commit: "commit",
  files: { "manifest.json": { size: 1, sha256: "0".repeat(64) } },
});
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let agent: typeof Agent;
let values: Map<string, unknown>;
let source: jest.Mocked<typeof import("./update-source")>;
let files: jest.Mocked<typeof import("./update-files")>;
let saved: jest.Mock;
let reload: jest.Mock;
let clearAlarm: jest.Mock;
let createAlarm: jest.Mock;
let connect: (port: chrome.runtime.Port) => void;
let message: (
  body: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value: unknown) => void,
) => unknown;

beforeEach(async () => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  jest.resetModules();
  values = new Map([["automatic", true]]);
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/150.0.0.0");
  const state = (await import("./update-store")) as jest.Mocked<typeof import("./update-store")>;
  state.getUpdateState.mockImplementation(async (key) => values.get(key) as never);
  state.setUpdateState.mockImplementation(async (key, value) => {
    if (value == null) {
      values.delete(key);
    } else {
      values.set(key, value);
    }
  });
  state.finishUpdate.mockImplementation(async (journal, outcome) => {
    values.delete("journal");
    values.delete("backups");
    values.set("history", [
      { at: NOW, fromVersion: journal.fromVersion, toVersion: journal.toVersion, outcome },
    ]);
  });
  source = (await import("./update-source")) as typeof source;
  source.findRemoteUpdate.mockResolvedValue({
    release: {
      ...config,
      version: "1.0.0.2",
      commit: "commit",
      releaseTag: "browser-custom-v1.0.0.2",
      minimumChromeVersion: "134.0",
      minimumUpdaterProtocol: 1,
      inventory: { name: "files.json", size: 1, sha256: "0".repeat(64) },
      full: { name: "extension.zip", size: 1, sha256: "0".repeat(64) },
      deltas: [],
    },
    assets: [],
  } as never);
  source.fetchUpdateAsset.mockImplementation(async (_config, _update, asset) =>
    asset.name === "files.json" ? encode(inventory("1.0.0.2")) : new Uint8Array([1]),
  );
  files = (await import("./update-files")) as typeof files;
  files.readUpdateFile.mockResolvedValue(encode(inventory("1.0.0.1")));
  files.unpackUpdate.mockResolvedValue(new Map());
  files.applyUpdateFiles.mockResolvedValue(undefined as never);
  saved = jest.fn().mockResolvedValue(undefined);
  reload = jest.fn();
  clearAlarm = jest.fn().mockResolvedValue(true);
  createAlarm = jest.fn();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        id: "test",
        getURL: (path: string) => "chrome-extension://test/" + path,
        getManifest: () => ({ version: "1.0.0.1" }),
        reload,
        getContexts: jest.fn().mockResolvedValue([]),
        onMessage: {
          addListener: (listener: typeof message) => {
            message = listener;
          },
        },
        onConnect: {
          addListener: (listener: typeof connect) => {
            connect = listener;
          },
        },
        sendMessage: jest.fn().mockResolvedValue(undefined),
      },
      management: { getSelf: jest.fn().mockResolvedValue({ installType: "development" }) },
      storage: { local: { set: saved } },
      alarms: { clear: clearAlarm, create: createAlarm, onAlarm: { addListener: jest.fn() } },
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: jest.fn().mockResolvedValue({ ok: true, json: async () => config }),
  });
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, action: () => Promise<void>) => {
        const pending = queue.then(action);
        queue = pending.catch((): void => {});
        return pending;
      },
    },
  });
  agent = (await import("./custom-update-agent")).CustomUpdateAgent;
});
afterEach(() => jest.restoreAllMocks());

async function send(operation: string, data = {}): Promise<Record<string, unknown>> {
  await agent.initializeBackground();
  return await new Promise((resolve) =>
    message(
      { customExtensionUpdate: operation, ...data },
      { id: "test", url: "chrome-extension://test/popup/index.html" },
      (value) => resolve(value as Record<string, unknown>),
    ),
  );
}

test("startup removes the legacy alarm and automatic preference without querying GitHub", async () => {
  await agent.initializeBackground();
  expect(clearAlarm).toHaveBeenCalledWith("customExtensionUpdateCheck");
  expect(createAlarm).not.toHaveBeenCalled();
  expect(values.has("automatic")).toBe(false);
  expect(source.findRemoteUpdate).not.toHaveBeenCalled();
});
test("opening a view and reading status never checks for versions", async () => {
  await send("state");
  await send("state");
  expect(source.findRemoteUpdate).not.toHaveBeenCalled();
});
test("the first unlock discovers an update but never downloads or applies its files", async () => {
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(1);
  expect(source.fetchUpdateAsset).not.toHaveBeenCalled();
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(values.get("checkResult")).toEqual({ checkedAt: NOW, availableVersion: "1.0.0.2" });
});
test("an unlock within 24 hours skips GitHub even across a fresh worker instance", async () => {
  values.set("checkResult", { checkedAt: NOW - DAY + 1, availableVersion: "1.0.0.2" });
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).not.toHaveBeenCalled();
  expect((await send("state")).availableVersion).toBe("1.0.0.2");
});
test("an unlock at exactly 24 hours checks again", async () => {
  values.set("checkResult", { checkedAt: NOW - DAY });
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(1);
});
test("simultaneous unlocks across windows share a single version check", async () => {
  await Promise.all(Array.from({ length: 8 }, () => agent.checkAfterUnlock()));
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(1);
});
test("an offline failure does not erase a previous result or retry on every unlock", async () => {
  const previous = { checkedAt: NOW - DAY, availableVersion: "1.0.0.2" };
  values.set("checkResult", previous);
  source.findRemoteUpdate.mockRejectedValueOnce(new Error("Offline"));
  await expect(agent.checkAfterUnlock()).rejects.toThrow("Offline");
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(1);
  expect(values.get("checkResult")).toEqual(previous);
  jest.spyOn(Date, "now").mockReturnValue(NOW + HOUR);
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(2);
});
test("a manual check bypasses the 24 hour gate without applying", async () => {
  values.set("checkResult", { checkedAt: NOW });
  await send("check");
  expect(source.findRemoteUpdate).toHaveBeenCalledTimes(1);
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
});
test("only the explicit apply command writes files and reloads", async () => {
  values.set("directory", { queryPermission: async () => "granted" });
  await send("check");
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
  const applied = await send("apply");
  expect(applied.error).toBeUndefined();
  expect(files.applyUpdateFiles).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
});
test("legacy clients cannot re-enable automatic application", async () => {
  const result = await send("automatic", { enabled: true });
  expect(result.status).toBe("error");
  expect(values.has("automatic")).toBe(false);
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
});
test("an interrupted update prevents an unlock check until recovery finishes", async () => {
  values.set("journal", { phase: "pendingReload", toVersion: "1.0.0.1" });
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).not.toHaveBeenCalled();
});
test("unconfigured builds never query GitHub on unlock", async () => {
  (fetch as jest.Mock).mockResolvedValue({ ok: false });
  await agent.checkAfterUnlock();
  expect(source.findRemoteUpdate).not.toHaveBeenCalled();
});

function screen(documentId: string, ready = true, reason?: string) {
  let receive!: (body: any) => void;
  const closed: Array<() => void> = [];
  return {
    name: "customExtensionUpdateView",
    sender: {
      id: "test",
      url: "chrome-extension://test/popup/index.html?uilocation=sidepanel",
      documentId,
    },
    onMessage: {
      addListener: (listener: typeof receive) => {
        receive = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: () => void) => {
        closed.push(listener);
      },
    },
    postMessage: jest.fn((body) => {
      if (body.type === "prepare") {
        receive({ type: "prepared", id: body.id, ready, reason });
      }
    }),
    disconnect: jest.fn(() => closed.forEach((listener) => listener())),
  } as unknown as chrome.runtime.Port;
}

test("apply prepares an already-open side panel without any permanent update port", async () => {
  values.set("directory", { queryPermission: async () => "granted" });
  const panel = screen("panel");
  jest.mocked(chrome.runtime.getContexts).mockResolvedValue([
    {
      documentId: "panel",
      documentUrl: "chrome-extension://test/popup/index.html?uilocation=sidepanel",
    },
  ] as never);
  jest.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
    connect(panel);
  });
  const result = await send("apply");
  expect(result.error).toBeUndefined();
  expect(files.applyUpdateFiles).toHaveBeenCalledTimes(1);
  expect(panel.postMessage).toHaveBeenCalledWith({ type: "release" });
  expect(panel.disconnect).toHaveBeenCalledTimes(1);
});

test("every open document must prepare, including a dirty form in another window", async () => {
  values.set("directory", { queryPermission: async () => "granted" });
  const panels = [screen("one"), screen("two", false, "Save the edited form.")];
  jest.mocked(chrome.runtime.getContexts).mockResolvedValue(
    ["one", "two"].map((documentId) => ({
      documentId,
      documentUrl: "chrome-extension://test/popup/index.html",
    })) as never,
  );
  jest.mocked(chrome.runtime.sendMessage).mockImplementation(async () => {
    panels.forEach(connect);
  });
  const result = await send("apply");
  expect(result.status).toBe("waiting");
  expect(result.error).toBe("Save the edited form.");
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  panels.forEach((panel) => expect(panel.postMessage).toHaveBeenCalledWith({ type: "release" }));
});

test("access revoked after connecting prevents writes without discarding the saved handle", async () => {
  const folder = { queryPermission: async () => "prompt" };
  values.set("directory", folder);
  const result = await send("apply");
  expect(result.folderPermission).toBe("prompt");
  expect(result.status).toBe("waiting");
  expect(values.get("directory")).toBe(folder);
  expect(files.applyUpdateFiles).not.toHaveBeenCalled();
});

test("only a healthy new version removes recovery bytes and records completion", async () => {
  const journal = {
    phase: "pendingReload",
    fromVersion: "1.0.0.0",
    toVersion: "1.0.0.1",
    target: encode(inventory("1.0.0.1")),
    backup: [{ path: "old.js", bytes: new Uint8Array([1]) }],
  };
  values.set("directory", { queryPermission: async () => "granted" });
  values.set("journal", journal);
  values.set("backups", [journal]);
  await agent.initializeBackground();
  expect(values.get("journal")).toBe(journal);
  await agent.markHealthy();
  expect(files.verifyDirectory).toHaveBeenCalledTimes(1);
  expect(values.has("journal")).toBe(false);
  expect(values.has("backups")).toBe(false);
  expect((await send("state")).history).toEqual([
    { at: NOW, fromVersion: "1.0.0.0", toVersion: "1.0.0.1", outcome: "applied" },
  ]);
});

test("failed startup file verification preserves the backup for recovery", async () => {
  const journal = {
    phase: "pendingReload",
    toVersion: "1.0.0.1",
    target: encode(inventory("1.0.0.1")),
    backup: ["recovery bytes"],
  };
  values.set("directory", { queryPermission: async () => "granted" });
  values.set("journal", journal);
  files.verifyDirectory.mockRejectedValueOnce(new Error("File verification failed"));
  await agent.initializeBackground();
  await expect(agent.markHealthy()).rejects.toThrow("File verification failed");
  expect(values.get("journal")).toBe(journal);
});
