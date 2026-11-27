import { SidePanelMode } from "../side-panel/side-panel-mode";

import {
  CONFIG_FILE,
  INSTALLED_FILE,
  UpdateConfig,
  UpdatePlan,
  compareVersions,
  fileChanges,
  sha256,
  validateInventory,
} from "./update-contract";
import {
  UpdateDirectory,
  UpdateJournal,
  applyUpdateFiles,
  readUpdateFile,
  rollbackUpdate,
  unpackUpdate,
  verifyDirectory,
} from "./update-files";
import { fetchUpdateAsset, findRemoteUpdate } from "./update-source";
import { UpdateHistoryEntry, finishUpdate, getUpdateState, setUpdateState } from "./update-store";

export const CUSTOM_UPDATE_STATUS = "customExtensionUpdateStatus";
export const CUSTOM_UPDATE_PORT = "customExtensionUpdateView";
const MESSAGE = "customExtensionUpdate";
const LEGACY_ALARM = "customExtensionUpdateCheck";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const FAILED_CHECK_RETRY = 60 * 60 * 1000;

export type UpdateCheckResult = { checkedAt: number; availableVersion?: string };

export type CustomUpdateStatus = {
  recoveryAvailable?: boolean;
  folderPermission?: PermissionState;
  history?: UpdateHistoryEntry[];
  configured: boolean;
  connected: boolean;
  status:
    | "unconfigured"
    | "idle"
    | "checking"
    | "available"
    | "applying"
    | "waiting"
    | "error"
    | "current";
  version: string;
  availableVersion?: string;
  repository?: string;
  checkedAt?: number;
  error?: string;
};

type UpdateView = {
  port: chrome.runtime.Port;
  documentId: string;
  ready: Map<string, (result: { ready: boolean; reason?: string }) => void>;
};

function internal(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) {
    return false;
  }
  const url = new URL(sender.url);
  const own = new URL(chrome.runtime.getURL("popup/index.html"));
  return url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
}

export class CustomUpdateAgent {
  private static config?: UpdateConfig;
  private static startup?: Promise<void>;
  private static views: UpdateView[] = [];
  private static state: CustomUpdateStatus;
  private static bootstrapped = false;
  private static preparation?: {
    id: string;
    expected: Set<string>;
    connected: (view: UpdateView) => void;
  };

  static initializeBackground(): Promise<void> {
    return (CustomUpdateAgent.startup ??= CustomUpdateAgent.initialize());
  }

  private static async initialize(): Promise<void> {
    CustomUpdateAgent.state = {
      configured: false,
      connected: false,
      status: "unconfigured",
      version: chrome.runtime.getManifest().version,
    };
    // eslint-disable-next-line no-restricted-syntax -- Registered once in the background worker only.
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!message?.[MESSAGE] || !internal(sender)) {
        return;
      }
      const operation = async () => {
        await CustomUpdateAgent.initializeBackground();
        switch (message[MESSAGE]) {
          case "state":
            if (CustomUpdateAgent.bootstrapped) {
              await CustomUpdateAgent.markHealthy();
            }
            return {
              ...CustomUpdateAgent.state,
              folderPermission: await (
                await getUpdateState<UpdateDirectory>("directory")
              )?.queryPermission({ mode: "readwrite" }),
              history: (await getUpdateState<UpdateHistoryEntry[]>("history")) ?? [],
              recoveryAvailable: !!(await getUpdateState("journal")),
            };
          case "check":
            await CustomUpdateAgent.run(false);
            break;
          case "apply":
            await CustomUpdateAgent.run(true);
            break;
          case "connect":
            await CustomUpdateAgent.connect();
            break;
          case "restore":
            await CustomUpdateAgent.withLock(async () => {
              const root = await getUpdateState<UpdateDirectory>("directory");
              const journal = await getUpdateState<UpdateJournal>("journal");
              if (!root || !journal) {
                throw new Error("No interrupted update is available to restore.");
              }
              if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") {
                throw new Error(
                  "Allow access to the saved installation folder before restoring files.",
                );
              }
              const blocked = await CustomUpdateAgent.prepareViews();
              if (blocked) {
                await CustomUpdateAgent.publish({ status: "waiting", error: blocked });
                return;
              }
              try {
                await rollbackUpdate(root, journal, (value) =>
                  value ? setUpdateState("journal", value) : finishUpdate(journal, "restored"),
                );
                chrome.runtime.reload();
              } finally {
                CustomUpdateAgent.releaseViews();
              }
            });
            break;
          default:
            throw new Error("Unknown update operation.");
        }
        await CustomUpdateAgent.publish();
        return CustomUpdateAgent.state;
      };
      void operation().then(respond, async (error: unknown) => {
        await CustomUpdateAgent.publish({ status: "error", error: String(error) });
        respond(CustomUpdateAgent.state);
      });
      return true;
    });
    // eslint-disable-next-line no-restricted-syntax -- Registered once in the background worker only.
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== CUSTOM_UPDATE_PORT || !port.sender?.documentId || !internal(port.sender)) {
        return;
      }
      const preparation = CustomUpdateAgent.preparation;
      if (
        !preparation?.expected.has(port.sender.documentId) ||
        CustomUpdateAgent.views.some((view) => view.documentId === port.sender!.documentId)
      ) {
        port.disconnect();
        return;
      }
      const view: UpdateView = { port, documentId: port.sender.documentId, ready: new Map() };
      CustomUpdateAgent.views.push(view);
      port.onMessage.addListener((message) => {
        if (message?.type === "prepared") {
          view.ready.get(message.id)?.({ ready: message.ready === true, reason: message.reason });
          view.ready.delete(message.id);
        }
      });
      port.onDisconnect.addListener(() => {
        CustomUpdateAgent.views = CustomUpdateAgent.views.filter((item) => item !== view);
        view.ready.forEach((resolve) =>
          resolve({
            ready: false,
            reason: "An extension screen disconnected. Reopen it and apply again.",
          }),
        );
      });
      preparation.connected(view);
    });
    try {
      // Remove the previous periodic updater without scheduling another background task.
      await chrome.alarms.clear(LEGACY_ALARM);
      const response = await fetch(chrome.runtime.getURL(CONFIG_FILE));
      if (!response.ok) {
        await CustomUpdateAgent.publish();
        return;
      }
      const config = (await response.json()) as UpdateConfig;
      const installation = await chrome.management.getSelf();
      if (config.schemaVersion !== 1 || installation.installType !== "development") {
        throw new Error("Custom file updates require the original unpacked release installation.");
      }
      CustomUpdateAgent.config = config;
      const root = await getUpdateState<UpdateDirectory>("directory");
      const checked = await getUpdateState<UpdateCheckResult>("checkResult");
      const availableVersion =
        checked?.availableVersion &&
        compareVersions(checked.availableVersion, CustomUpdateAgent.state.version) > 0
          ? checked.availableVersion
          : undefined;
      await setUpdateState("automatic", null);
      await CustomUpdateAgent.publish({
        configured: true,
        connected: !!root,
        folderPermission: await root?.queryPermission({ mode: "readwrite" }),
        history: (await getUpdateState<UpdateHistoryEntry[]>("history")) ?? [],
        checkedAt: checked?.checkedAt,
        availableVersion,
        status: availableVersion ? "available" : "idle",
        repository: config.repository,
      });
      const journal = await getUpdateState<UpdateJournal>("journal");
      await CustomUpdateAgent.publish({ recoveryAvailable: !!journal });
      if (journal?.phase === "applying" && root) {
        if ((await root.queryPermission({ mode: "readwrite" })) === "granted") {
          await rollbackUpdate(root, journal, (value) =>
            value ? setUpdateState("journal", value) : finishUpdate(journal, "restored"),
          );
          if (journal.fromVersion !== chrome.runtime.getManifest().version) {
            chrome.runtime.reload();
            return;
          }
          await CustomUpdateAgent.publish({
            status: "waiting",
            error: "An interrupted update was restored. Check for updates again.",
            recoveryAvailable: false,
            history: (await getUpdateState<UpdateHistoryEntry[]>("history")) ?? [],
          });
        } else {
          await CustomUpdateAgent.publish({
            status: "waiting",
            error: "Allow folder access to recover the interrupted update.",
          });
        }
      } else if (
        journal?.phase === "pendingReload" &&
        journal.toVersion !== chrome.runtime.getManifest().version
      ) {
        chrome.runtime.reload();
        return;
      }
    } catch (error) {
      await CustomUpdateAgent.publish({ status: "error", error: String(error) });
    }
  }

  private static async publish(changes: Partial<CustomUpdateStatus> = {}): Promise<void> {
    if (changes.status === "error") {
      changes.recoveryAvailable = !!(await getUpdateState("journal").catch(
        (): undefined => undefined,
      ));
    }
    CustomUpdateAgent.state = { ...CustomUpdateAgent.state, ...changes };
    await chrome.storage.local.set({ [CUSTOM_UPDATE_STATUS]: CustomUpdateAgent.state });
  }

  private static async withLock<T>(action: () => Promise<T>): Promise<T> {
    return await navigator.locks.request("bitwarden-custom-extension-update", action);
  }

  private static async connect(): Promise<void> {
    if (!CustomUpdateAgent.config) {
      throw new Error("This build does not contain a custom update configuration.");
    }
    await CustomUpdateAgent.withLock(async () => {
      if (await getUpdateState("journal")) {
        throw new Error("Restore or finish the pending update before changing folders.");
      }
      const root = await getUpdateState<UpdateDirectory>("directoryCandidate");
      if (!root || (await root.queryPermission({ mode: "readwrite" })) !== "granted") {
        throw new Error("Select the installed release folder and allow write access.");
      }
      const baseline = validateInventory(
        JSON.parse(new TextDecoder().decode(await readUpdateFile(root, INSTALLED_FILE))),
        CustomUpdateAgent.config!,
      );
      const manifest = JSON.parse(
        new TextDecoder().decode(await readUpdateFile(root, "manifest.json")),
      );
      if (
        baseline.version !== chrome.runtime.getManifest().version ||
        manifest.key !== chrome.runtime.getManifest().key
      ) {
        throw new Error("The selected folder is not this installed version.");
      }
      await verifyDirectory(root, baseline);
      await setUpdateState("directory", root);
      await setUpdateState("directoryCandidate", null);
      await CustomUpdateAgent.publish({
        connected: true,
        folderPermission: "granted",
        status: "idle",
        error: undefined,
      });
    });
  }

  static async markHealthy(): Promise<void> {
    CustomUpdateAgent.bootstrapped = true;
    if (!CustomUpdateAgent.config) {
      return;
    }
    await CustomUpdateAgent.withLock(() => CustomUpdateAgent.finishHealthyUpdate());
  }

  private static async finishHealthyUpdate(): Promise<void> {
    if (!CustomUpdateAgent.config) {
      return;
    }
    const journal = await getUpdateState<UpdateJournal>("journal");
    if (
      journal?.phase === "pendingReload" &&
      journal.toVersion === chrome.runtime.getManifest().version
    ) {
      const root = await getUpdateState<UpdateDirectory>("directory");
      if (!root) {
        return;
      }
      if ((await root.queryPermission({ mode: "readwrite" })) !== "granted") {
        await CustomUpdateAgent.publish({
          status: "waiting",
          recoveryAvailable: true,
          error: "Allow access to the saved installation folder to verify and finish this update.",
        });
        return;
      }
      await verifyDirectory(
        root,
        validateInventory(
          JSON.parse(new TextDecoder().decode(journal.target)),
          CustomUpdateAgent.config!,
        ),
      );
      await setUpdateState("highestVersion", journal.toVersion);
      await finishUpdate(journal, "applied");
      await CustomUpdateAgent.publish({
        status: "current",
        error: undefined,
        recoveryAvailable: false,
        history: (await getUpdateState<UpdateHistoryEntry[]>("history")) ?? [],
      });
    }
  }

  private static releaseViews(): void {
    CustomUpdateAgent.preparation = undefined;
    for (const view of CustomUpdateAgent.views) {
      try {
        view.port.postMessage({ type: "release" });
      } catch {
        // Closed views release their own inert state on disconnect.
      } finally {
        try {
          view.port.disconnect();
        } catch {
          /* Already disconnected. */
        }
      }
    }
    CustomUpdateAgent.views = [];
  }

  private static async prepareViews(): Promise<string | undefined> {
    if (SidePanelMode.hasActiveRequests) {
      return "A side-panel authentication request is still pending. Finish or cancel that request before applying the update.";
    }
    const ownPage = chrome.runtime.getURL("popup/index.html");
    const pages = (await chrome.runtime.getContexts({})).filter(
      (context) => context.documentUrl?.split("?")[0].split("#")[0] === ownPage,
    );
    if (!pages.length) {
      return undefined;
    }
    const id = crypto.randomUUID();
    const results = new Map<string, { ready: boolean; reason?: string }>();
    let complete!: () => void;
    const answered = new Promise<void>((resolve) => {
      complete = resolve;
    });
    CustomUpdateAgent.preparation = {
      id,
      expected: new Set(pages.map((page) => page.documentId)),
      connected: (view) => {
        view.ready.set(id, (result) => {
          results.set(view.documentId, result);
          if (results.size === pages.length) {
            complete();
          }
        });
        try {
          view.port.postMessage({ type: "prepare", id });
        } catch {
          view.ready.get(id)?.({
            ready: false,
            reason: "An extension screen disconnected during update preparation. Try again.",
          });
        }
      },
    };
    const timer = setTimeout(complete, 3000);
    try {
      // UI listeners create a transaction-only port. No pre-existing connection is required.
      // sendMessage's single response is deliberately ignored: every document answers separately.
      void chrome.runtime.sendMessage({ customExtensionUpdatePrepare: id }).catch(() => {});
      await answered;
      const current = (await chrome.runtime.getContexts({})).filter(
        (context) => context.documentUrl?.split("?")[0].split("#")[0] === ownPage,
      );
      for (const page of current) {
        const result = results.get(page.documentId);
        if (!result?.ready) {
          CustomUpdateAgent.releaseViews();
          return (
            result?.reason ??
            "An extension screen did not respond to the update request. Reopen that screen and try again."
          );
        }
      }
      return undefined;
    } catch (error) {
      CustomUpdateAgent.releaseViews();
      throw error;
    } finally {
      clearTimeout(timer);
      CustomUpdateAgent.preparation = undefined;
    }
  }

  /** Invoked only by a completed, non-restored unlock; never by opening a view. */
  static async checkAfterUnlock(): Promise<void> {
    await CustomUpdateAgent.initializeBackground();
    if (!CustomUpdateAgent.config) {
      return;
    }
    await CustomUpdateAgent.withLock(async () => {
      if (await getUpdateState("journal")) {
        return;
      }
      const now = Date.now();
      const checked = await getUpdateState<UpdateCheckResult>("checkResult");
      const attempted = await getUpdateState<number>("lastCheckAttempt");
      if (checked && now - checked.checkedAt < CHECK_INTERVAL) {
        return;
      }
      if (attempted != null && now - attempted < FAILED_CHECK_RETRY) {
        return;
      }
      try {
        await CustomUpdateAgent.performCheck(false);
      } catch (error) {
        await CustomUpdateAgent.publish({ status: "error", error: String(error) });
        throw error;
      }
    });
  }

  static async run(apply: boolean): Promise<void> {
    await CustomUpdateAgent.initializeBackground();
    await CustomUpdateAgent.withLock(() => CustomUpdateAgent.performCheck(apply));
  }

  private static async performCheck(apply: boolean): Promise<void> {
    const config = CustomUpdateAgent.config;
    if (!config) {
      throw new Error("Updates are not configured for this build.");
    }
    if (await getUpdateState("journal")) {
      throw new Error("A pending update must finish or be restored first.");
    }
    await CustomUpdateAgent.publish({ status: "checking", error: undefined });
    const current = chrome.runtime.getManifest().version;
    const highest = (await getUpdateState<string>("highestVersion")) ?? current;
    await setUpdateState("lastCheckAttempt", Date.now());
    const update = await findRemoteUpdate(
      config,
      compareVersions(highest, current) > 0 ? highest : current,
    );
    const result: UpdateCheckResult = {
      checkedAt: Date.now(),
      availableVersion: update?.release.version,
    };
    await setUpdateState("checkResult", result);
    if (!update) {
      await CustomUpdateAgent.publish({
        status: "current",
        checkedAt: result.checkedAt,
        availableVersion: undefined,
      });
      return;
    }
    await CustomUpdateAgent.publish({
      status: "available",
      availableVersion: update.release.version,
      checkedAt: result.checkedAt,
    });
    if (!apply) {
      return;
    }
    const root = await getUpdateState<UpdateDirectory>("directory");
    if (!root || (await root.queryPermission({ mode: "readwrite" })) !== "granted") {
      await CustomUpdateAgent.publish({
        status: "waiting",
        error: "Allow access to the saved installation folder before applying this update.",
        folderPermission: root ? await root.queryPermission({ mode: "readwrite" }) : undefined,
      });
      return;
    }
    const chromeVersion = navigator.userAgent.match(
      /(?:Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/,
    )?.[1];
    if (!chromeVersion || compareVersions(chromeVersion, update.release.minimumChromeVersion) < 0) {
      throw new Error("Update Chrome before installing this release.");
    }
    const baselineBytes = await readUpdateFile(root, INSTALLED_FILE);
    const baseline = validateInventory(JSON.parse(new TextDecoder().decode(baselineBytes)), config);
    if (baseline.version !== current) {
      throw new Error("The selected installation does not match the running extension.");
    }
    const inventoryBytes = await fetchUpdateAsset(config, update, update.release.inventory);
    const inventory = validateInventory(
      JSON.parse(new TextDecoder().decode(inventoryBytes)),
      config,
    );
    if (
      inventory.version !== update.release.version ||
      inventory.commit !== update.release.commit
    ) {
      throw new Error("The inventory has the wrong version or commit.");
    }
    // Resolve the baseline digest once; a version string alone is never a patch identifier.
    async function selectPayload(): Promise<Uint8Array> {
      const baseHash = await sha256(baselineBytes);
      const matching = update!.release.deltas.find(
        (item) => item.fromVersion === current && item.fromInventorySha256 === baseHash,
      );
      if (!matching) {
        return fetchUpdateAsset(config!, update!, update!.release.full);
      }
      const planBytes = await fetchUpdateAsset(config!, update!, matching.plan);
      const plan = JSON.parse(new TextDecoder().decode(planBytes)) as UpdatePlan;
      const changes = fileChanges(baseline, inventory);
      if (
        plan.schemaVersion !== 1 ||
        plan.fromVersion !== current ||
        plan.toVersion !== inventory.version ||
        plan.fromInventorySha256 !== baseHash ||
        plan.toInventorySha256 !== update!.release.inventory.sha256 ||
        JSON.stringify(plan.write) !== JSON.stringify(changes.write) ||
        JSON.stringify(plan.delete) !== JSON.stringify(changes.delete)
      ) {
        throw new Error("The delta plan does not match the inventories.");
      }
      return fetchUpdateAsset(config!, update!, matching.payload);
    }
    const payload = await unpackUpdate(await selectPayload());
    const blocked = await CustomUpdateAgent.prepareViews();
    if (blocked) {
      await CustomUpdateAgent.publish({
        status: "waiting",
        error: blocked,
      });
      return;
    }
    try {
      await CustomUpdateAgent.publish({ status: "applying" });
      let journal: UpdateJournal | undefined;
      await applyUpdateFiles(root, baselineBytes, inventoryBytes, payload, async (value) => {
        if (value) {
          journal = value;
          await setUpdateState("journal", value);
        } else if (journal) {
          await finishUpdate(journal, "restored");
        }
      });
      chrome.runtime.reload();
    } finally {
      CustomUpdateAgent.releaseViews();
    }
  }
}

/** Register once per UI document; ports exist only while an update is being applied. */
export function connectUpdateView(): () => void {
  let port: chrome.runtime.Port | undefined;
  const release = () => {
    document.body.inert = false;
  };
  const listener = (message: any, sender: chrome.runtime.MessageSender) => {
    if (!message?.customExtensionUpdatePrepare || sender.id !== chrome.runtime.id || port) {
      return;
    }
    const transaction = message.customExtensionUpdatePrepare;
    const connection = chrome.runtime.connect({ name: CUSTOM_UPDATE_PORT });
    port = connection;
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === connection) {
        port = undefined;
        release();
      }
    });
    connection.onMessage.addListener((message) => {
      if (message?.type === "release") {
        release();
      } else if (message?.type === "prepare" && message.id === transaction) {
        const busyRoute =
          /#\/(?:add-cipher|edit-cipher|add-send|edit-send|attachments|import(?:-[a-z-]+)?|fido2|http-authentication|2fa|sso)(?:[/?;]|$)/.test(
            globalThis.location.href,
          );
        const dirty =
          !!document.querySelector("form.ng-dirty") &&
          !/#\/(?:appearance|custom-updates)(?:[/?]|$)/.test(globalThis.location.href);
        const ready = !busyRoute && !dirty;
        if (ready) {
          document.body.inert = true;
        }
        try {
          connection.postMessage({
            type: "prepared",
            id: message.id,
            ready,
            ...(!ready
              ? {
                  reason: busyRoute
                    ? "Finish editing, authentication or import in the other extension screen before applying this update."
                    : "Save or cancel the edited form before applying this update.",
                }
              : {}),
          });
        } catch {
          port = undefined;
          release();
        }
      }
    });
  };
  // eslint-disable-next-line no-restricted-syntax -- This listener belongs to the UI document lifetime.
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
    release();
    try {
      port?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    port = undefined;
  };
}

export async function customUpdateOperation(
  operation: string,
  data: Record<string, unknown> = {},
): Promise<CustomUpdateStatus> {
  const result = await chrome.runtime.sendMessage({ [MESSAGE]: operation, ...data });
  if (!result || typeof result.status !== "string") {
    throw new Error("The update service is unavailable.");
  }
  return result as CustomUpdateStatus;
}
