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
import { getUpdateState, setUpdateState } from "./update-store";

export const CUSTOM_UPDATE_STATUS = "customExtensionUpdateStatus";
export const CUSTOM_UPDATE_PORT = "customExtensionUpdateView";
const MESSAGE = "customExtensionUpdate";
const LEGACY_ALARM = "customExtensionUpdateCheck";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const FAILED_CHECK_RETRY = 60 * 60 * 1000;

export type UpdateCheckResult = { checkedAt: number; availableVersion?: string };

export type CustomUpdateStatus = {
  recoveryAvailable?: boolean;
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
  ready: Map<string, (ready: boolean) => void>;
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
        switch (message[MESSAGE]) {
          case "state":
            return {
              ...CustomUpdateAgent.state,
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
              await rollbackUpdate(root, journal, (value) => setUpdateState("journal", value));
              chrome.runtime.reload();
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
      const view: UpdateView = { port, documentId: port.sender.documentId, ready: new Map() };
      CustomUpdateAgent.views.push(view);
      port.onMessage.addListener((message) => {
        if (message?.type === "prepared") {
          view.ready.get(message.id)?.(message.ready === true);
          view.ready.delete(message.id);
        }
      });
      port.onDisconnect.addListener(() => {
        CustomUpdateAgent.views = CustomUpdateAgent.views.filter((item) => item !== view);
        view.ready.forEach((resolve) => resolve(false));
      });
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
        checkedAt: checked?.checkedAt,
        availableVersion,
        status: availableVersion ? "available" : "idle",
        repository: config.repository,
      });
      const journal = await getUpdateState<UpdateJournal>("journal");
      await CustomUpdateAgent.publish({ recoveryAvailable: !!journal });
      if (journal?.phase === "applying" && root) {
        if ((await root.queryPermission({ mode: "readwrite" })) === "granted") {
          await rollbackUpdate(root, journal, (value) => setUpdateState("journal", value));
          if (journal.fromVersion !== chrome.runtime.getManifest().version) {
            chrome.runtime.reload();
            return;
          }
          await CustomUpdateAgent.publish({
            status: "waiting",
            error: "An interrupted update was restored. Check for updates again.",
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
        status: "idle",
        error: undefined,
      });
    });
  }

  static async markHealthy(): Promise<void> {
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
      await verifyDirectory(
        root,
        validateInventory(
          JSON.parse(new TextDecoder().decode(journal.target)),
          CustomUpdateAgent.config!,
        ),
      );
      await setUpdateState("highestVersion", journal.toVersion);
      await setUpdateState("journal", null);
      await CustomUpdateAgent.publish({
        status: "current",
        error: undefined,
        recoveryAvailable: false,
      });
    }
  }

  private static releaseViews(): void {
    for (const view of CustomUpdateAgent.views) {
      try {
        view.port.postMessage({ type: "release" });
      } catch {
        /* The view was closed during the update. */
      }
    }
  }

  private static async prepareViews(): Promise<boolean> {
    if (SidePanelMode.hasActiveRequests) {
      return false;
    }
    const contexts = await chrome.runtime.getContexts({});
    const ownPage = chrome.runtime.getURL("popup/index.html");
    const pages = contexts.filter((context) => context.documentUrl?.startsWith(ownPage));
    if (
      pages.some(
        (page) => !CustomUpdateAgent.views.some((view) => view.documentId === page.documentId),
      )
    ) {
      return false;
    }
    const results = await Promise.all(
      CustomUpdateAgent.views.map(
        (view) =>
          new Promise<boolean>((resolve) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
              view.ready.delete(id);
              resolve(false);
            }, 2000);
            view.ready.set(id, (ready) => {
              clearTimeout(timer);
              resolve(ready);
            });
            try {
              view.port.postMessage({ type: "prepare", id });
            } catch {
              clearTimeout(timer);
              view.ready.delete(id);
              resolve(false);
            }
          }),
      ),
    );
    const prepared = results.every(Boolean);
    if (!prepared) {
      CustomUpdateAgent.releaseViews();
    }
    return prepared;
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
        error: "Reconnect the installation folder to allow this update.",
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
    if (!(await CustomUpdateAgent.prepareViews())) {
      await CustomUpdateAgent.publish({
        status: "waiting",
        error: "Finish editing or authentication before applying this update.",
      });
      return;
    }
    await CustomUpdateAgent.publish({ status: "applying" });
    try {
      await applyUpdateFiles(root, baselineBytes, inventoryBytes, payload, (value) =>
        setUpdateState("journal", value),
      );
      chrome.runtime.reload();
    } finally {
      CustomUpdateAgent.releaseViews();
    }
  }
}

export function connectUpdateView(): () => void {
  const port = chrome.runtime.connect({ name: CUSTOM_UPDATE_PORT });
  if (!port?.onMessage) {
    return () => undefined;
  }
  port.onMessage.addListener((message) => {
    if (message?.type === "prepare") {
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
      port.postMessage({ type: "prepared", id: message.id, ready });
    } else if (message?.type === "release") {
      document.body.inert = false;
    }
  });
  port.onDisconnect?.addListener(() => {
    document.body.inert = false;
  });
  return () => {
    document.body.inert = false;
    port.disconnect();
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
