/* eslint-disable no-restricted-syntax -- Chrome-only broker: supported() excludes Safari; background and panel listeners have separate document lifetimes. */
import { BehaviorSubject, Subject } from "rxjs";

import { ForegroundPort } from "../browser/foreground-port";

import { focusSidePanelUnlock } from "./side-panel-unlock-focus";

export const SIDE_PANEL_MODE_KEY = "customSidePanelModeEnabled";
export const SIDE_PANEL_PATH = "popup/index.html?uilocation=sidepanel";
const MESSAGE = "customSidePanel";
const PORT = "customSidePanelView";
const VIRTUAL_WINDOW_START = -1_000_000;
const REQUEST_TIMEOUT = 120_000;

type PanelRequest = {
  id: number;
  revision: number;
  windowId: number;
  key: string;
  url: string;
  expires: number;
  documentId?: string;
};

type PanelConnection = {
  port: chrome.runtime.Port;
  windowId: number;
  documentId: string;
  tabId: number;
};

export type PanelOpenOptions = { senderWindowId?: number; singleActionKey?: string };

/** Shared by the background and foreground; Chrome storage is the single source of truth. */
export class SidePanelMode {
  private static readonly enabledSubject = new BehaviorSubject(false);
  static readonly enabled$ = SidePanelMode.enabledSubject.asObservable();
  /** Virtual popout cancellation events, consumed by existing request lifecycles. */
  private static readonly cancelledSubject = new Subject<number>();
  static readonly cancelled$ = SidePanelMode.cancelledSubject.asObservable();

  private static loading: Promise<void> | undefined;
  private static background = false;
  private static initialized = false;
  private static nextWindowId = VIRTUAL_WINDOW_START;
  private static lastWindowId: number | undefined;
  private static requests: PanelRequest[] = [];
  private static panels: PanelConnection[] = [];
  private static configuring: Promise<void> = Promise.resolve();
  private static viewPort?: ForegroundPort;
  private static lastRoutes: Record<number, string> = {};
  private static pendingBadge = false;
  static get hasActiveRequests(): boolean {
    return SidePanelMode.requests.some((item) => !item.key.startsWith("navigation_"));
  }
  static get owningWindowId(): number | undefined {
    return SidePanelMode.lastWindowId;
  }
  static notifyReady(): void {
    SidePanelMode.viewPort?.send({ type: "ready" });
  }
  static recordRoute(route: string): void {
    if (
      /^\/(?:tabs\/(?:vault|generator|send|settings)|appearance|custom-updates|generator|folders)$/.test(
        route,
      )
    ) {
      SidePanelMode.viewPort?.send({ type: "route", route });
    }
  }
  private static expiryTimer: ReturnType<typeof setTimeout> | undefined;

  static get supported(): boolean {
    return (
      typeof chrome !== "undefined" &&
      typeof chrome.sidePanel?.open === "function" &&
      typeof chrome.sidePanel?.setPanelBehavior === "function"
    );
  }

  static get enabled(): boolean {
    return SidePanelMode.supported && SidePanelMode.enabledSubject.value;
  }

  static ready(): Promise<void> {
    return (SidePanelMode.loading ??= (async () => {
      if (!SidePanelMode.supported || !chrome.storage?.local) {
        return;
      }
      const stored = await chrome.storage.local.get(SIDE_PANEL_MODE_KEY);
      SidePanelMode.enabledSubject.next(stored[SIDE_PANEL_MODE_KEY] === true);
      if (!SidePanelMode.background) {
        const current = await chrome.windows.getCurrent();
        const owner =
          current.type === "normal"
            ? current
            : await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        SidePanelMode.lastWindowId = owner.id;
      }
      if (chrome.storage.session?.get) {
        const routes = await chrome.storage.session.get("customSidePanelRoutes");
        SidePanelMode.lastRoutes = routes.customSidePanelRoutes ?? {};
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && SIDE_PANEL_MODE_KEY in changes) {
          SidePanelMode.enabledSubject.next(changes[SIDE_PANEL_MODE_KEY].newValue === true);
        }
      });
    })());
  }

  static async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && !SidePanelMode.supported) {
      throw new Error("Side Panel API is unavailable in this browser.");
    }
    const response = await chrome.runtime.sendMessage({ [MESSAGE]: "setMode", enabled });
    if (!response?.ok) {
      throw new Error(response?.error ?? "The background could not change the display mode.");
    }
    SidePanelMode.enabledSubject.next(enabled);
  }

  static inPanel(win: Window): boolean {
    try {
      return new URL(win.location.href).searchParams.get("uilocation") === "sidepanel";
    } catch {
      return false;
    }
  }

  static isVirtualWindow(windowId: number): boolean {
    return windowId <= VIRTUAL_WINDOW_START;
  }

  static panelUrl(path: string, key?: string): string {
    const url = new URL(path, chrome.runtime.getURL("/"));
    const root = new URL(chrome.runtime.getURL("/"));
    if (
      url.protocol !== root.protocol ||
      url.host !== root.host ||
      url.pathname !== "/popup/index.html"
    ) {
      throw new Error("Only the extension's own UI can open in its side panel.");
    }
    url.searchParams.set("uilocation", "sidepanel");
    if (key) {
      url.searchParams.set("singleActionPopout", key);
    }
    return url.href;
  }

  static isUiUrl(path: string): boolean {
    try {
      SidePanelMode.panelUrl(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Start at the event boundary, before authentication, IPC or tab queries consume the click. */
  static reveal(windowId = SidePanelMode.lastWindowId): Promise<void> | undefined {
    if (!SidePanelMode.enabled || windowId == null || windowId < 0) {
      return;
    }
    // Requests without a usable gesture remain queued and are delivered on the next icon click.
    return chrome.sidePanel.open({ windowId }).catch((): void => {});
  }

  /** Returns null only when the mode is off. A queued request never falls back to a popout. */
  static async open(
    path = "popup/index.html",
    options: PanelOpenOptions = {},
  ): Promise<chrome.windows.Window | null> {
    // Dispatch before storage/IPC awaits when the event already supplied the owning window.
    let opening = SidePanelMode.reveal(options.senderWindowId);
    await SidePanelMode.ready();
    if (!SidePanelMode.enabled) {
      return null;
    }
    // A cold foreground may not have loaded the preference or owning window at entry.
    opening ??= SidePanelMode.reveal(options.senderWindowId);
    const url = SidePanelMode.panelUrl(path, options.singleActionKey);
    const ownedOptions = {
      ...options,
      senderWindowId: options.senderWindowId ?? SidePanelMode.lastWindowId,
    };
    const request = SidePanelMode.background
      ? await SidePanelMode.enqueue(url, ownedOptions)
      : await chrome.runtime.sendMessage({ [MESSAGE]: "open", url, options: ownedOptions });
    if (!request?.id || request.error) {
      throw new Error(request?.error ?? "No browser window is available for this request.");
    }
    await opening;
    return { id: request.id, type: "popup", focused: true } as chrome.windows.Window;
  }

  static async closeKey(key: string, cancelled = false): Promise<boolean> {
    if (!SidePanelMode.supported) {
      return false;
    }
    if (SidePanelMode.background) {
      return SidePanelMode.finish(key, cancelled);
    }
    const response = await chrome.runtime.sendMessage({ [MESSAGE]: "close", key, cancelled });
    return response?.closed === true;
  }

  static async closeVirtual(windowId: number): Promise<void> {
    if (SidePanelMode.background) {
      const request = SidePanelMode.requests.find((item) => item.id === windowId);
      if (request) {
        SidePanelMode.finish(request.key, false, request.id);
      }
      return;
    }
    await chrome.runtime.sendMessage({ [MESSAGE]: "closeVirtual", windowId });
  }

  static async focusVirtual(windowId: number): Promise<void> {
    if (SidePanelMode.background) {
      const request = SidePanelMode.requests.find((item) => item.id === windowId);
      if (request) {
        SidePanelMode.deliver(request.windowId);
        await chrome.windows.update(request.windowId, { focused: true });
      }
      return;
    }
    await chrome.runtime.sendMessage({ [MESSAGE]: "focusVirtual", windowId });
  }

  static ownsRequest(sender: chrome.runtime.MessageSender | undefined, key: string): boolean {
    return (
      !!sender?.documentId &&
      SidePanelMode.requests.some(
        (item) => item.key === key && item.documentId === sender.documentId,
      )
    );
  }

  static hasRequest(key: string): boolean {
    return SidePanelMode.requests.some((item) => item.key === key);
  }

  private static internal(sender: chrome.runtime.MessageSender): boolean {
    if (sender.id !== chrome.runtime.id || !sender.url) {
      return false;
    }
    const url = new URL(sender.url);
    return (
      url.protocol === new URL(chrome.runtime.getURL("/")).protocol &&
      url.host === new URL(chrome.runtime.getURL("/")).host &&
      url.pathname === "/popup/index.html"
    );
  }

  static async initializeBackground(): Promise<void> {
    if (SidePanelMode.initialized || !SidePanelMode.supported) {
      return;
    }
    SidePanelMode.initialized = true;
    SidePanelMode.background = true;
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!message?.[MESSAGE] || !SidePanelMode.internal(sender)) {
        return;
      }
      const action = async () => {
        switch (message[MESSAGE]) {
          case "setMode": {
            if (typeof message.enabled !== "boolean") {
              throw new Error("Invalid display mode.");
            }
            SidePanelMode.configuring = SidePanelMode.configuring
              .catch((): void => {})
              .then(async () => {
                if (SidePanelMode.requests.some((item) => !item.key.startsWith("navigation_"))) {
                  throw new Error("Finish or cancel the current authentication request first.");
                }
                const previous = SidePanelMode.enabled;
                try {
                  await SidePanelMode.configure(message.enabled);
                  await chrome.storage.local.set({ [SIDE_PANEL_MODE_KEY]: message.enabled });
                  SidePanelMode.enabledSubject.next(message.enabled);
                } catch (error) {
                  await SidePanelMode.configure(previous);
                  throw error;
                }
              });
            await SidePanelMode.configuring;
            return { ok: true };
          }
          case "open":
            await SidePanelMode.ready();
            if (!SidePanelMode.enabled) {
              throw new Error("Side panel mode is disabled.");
            }
            return await SidePanelMode.enqueue(
              SidePanelMode.panelUrl(message.url),
              message.options,
            );
          case "close": {
            // A panel may only close the request currently delivered to its own document.
            if (
              SidePanelMode.inPanel({ location: { href: sender.url! } } as Window) &&
              !SidePanelMode.ownsRequest(sender, message.key)
            ) {
              return { closed: false };
            }
            const request = SidePanelMode.requests.find(
              (item) => item.key === message.key && item.documentId === sender.documentId,
            );
            return {
              closed:
                !!request &&
                SidePanelMode.finish(request.key, message.cancelled === true, request.id),
            };
          }
          case "closeVirtual":
            if (
              SidePanelMode.requests.some(
                (item) => item.id === message.windowId && item.documentId === sender.documentId,
              )
            ) {
              await SidePanelMode.closeVirtual(message.windowId);
            }
            return { ok: true };
          case "focusVirtual":
            await SidePanelMode.focusVirtual(message.windowId);
            return { ok: true };
        }
      };
      void action().then(respond, (error: unknown) => respond({ error: String(error) }));
      return true;
    });
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT || !port.sender || !SidePanelMode.internal(port.sender)) {
        return;
      }
      void SidePanelMode.register(port).catch(() => port.disconnect());
    });
    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId >= 0) {
        void chrome.windows
          .get(windowId)
          .then((win) => {
            if (win.type === "normal") {
              SidePanelMode.lastWindowId = windowId;
            }
          })
          .catch((): void => {});
      }
    });
    chrome.windows.onRemoved.addListener((windowId) => {
      for (const request of [...SidePanelMode.requests]) {
        if (request.windowId === windowId) {
          SidePanelMode.finish(request.key, true, request.id);
        }
      }
    });
    await SidePanelMode.ready();
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    SidePanelMode.lastWindowId = win.id;
    await SidePanelMode.configure(SidePanelMode.enabled);
  }

  private static async configure(enabled: boolean): Promise<void> {
    await chrome.sidePanel.setOptions({ path: SIDE_PANEL_PATH, enabled });
    await chrome.action.setPopup({ popup: enabled ? "" : "popup/index.html" });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: enabled });
    if (enabled) {
      // Legacy triage panels are tab-specific. Migrate their UI too; connection selection
      // below distinguishes these instances from the default window panel.
      const tabs = await chrome.tabs.query({});
      await Promise.all(
        tabs
          .filter((tab) => tab.id != null)
          .map(async (tab) => {
            const options = await chrome.sidePanel.getOptions({ tabId: tab.id });
            if (options.tabId != null) {
              await chrome.sidePanel.setOptions({
                tabId: tab.id,
                path: SIDE_PANEL_PATH,
                enabled: true,
              });
            }
          }),
      );
    }
  }

  private static async enqueue(url: string, options: PanelOpenOptions = {}): Promise<PanelRequest> {
    const windowId =
      options.senderWindowId ??
      SidePanelMode.lastWindowId ??
      (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    if (
      windowId == null ||
      windowId < 0 ||
      (await chrome.windows.get(windowId)).type !== "normal"
    ) {
      throw new Error("The request must belong to a normal browser window.");
    }
    const key = options.singleActionKey ?? `navigation_${crypto.randomUUID()}`;
    let request = SidePanelMode.requests.find(
      (item) => item.key === key && item.windowId === windowId,
    );
    if (!request) {
      request = {
        id: SidePanelMode.nextWindowId--,
        revision: 0,
        windowId,
        key,
        url,
        expires: Date.now() + REQUEST_TIMEOUT,
      };
      SidePanelMode.requests.push(request);
    } else {
      request.url = url;
      request.revision++;
    }
    SidePanelMode.deliver(windowId);
    clearTimeout(SidePanelMode.expiryTimer);
    SidePanelMode.expiryTimer = setTimeout(() => SidePanelMode.expire(), 1000);
    return request;
  }

  private static expire(): void {
    for (const request of [...SidePanelMode.requests]) {
      if (request.expires <= Date.now()) {
        SidePanelMode.finish(request.key, true, request.id);
      }
    }
    if (SidePanelMode.requests.length) {
      SidePanelMode.expiryTimer = setTimeout(() => SidePanelMode.expire(), 1000);
    }
  }

  private static finish(key: string, cancelled: boolean, requestId?: number): boolean {
    // Prefix closure is used only by trusted background cleanup (for example all HTTP prompts).
    // UI closure, expiry and window removal always target one exact virtual request.
    const matches = SidePanelMode.requests.filter((item) =>
      requestId != null ? item.id === requestId : item.key.startsWith(key),
    );
    SidePanelMode.requests = SidePanelMode.requests.filter((item) => !matches.includes(item));
    for (const item of matches) {
      if (cancelled) {
        SidePanelMode.cancelledSubject.next(item.id);
      }
      if (SidePanelMode.requests.some((request) => request.windowId === item.windowId)) {
        SidePanelMode.deliver(item.windowId);
      } else {
        for (const panel of SidePanelMode.panels.filter(
          (panel) => panel.windowId === item.windowId,
        )) {
          SidePanelMode.sendPanel(panel, { type: "finished" });
        }
      }
    }
    SidePanelMode.updatePendingBadge();
    return matches.length > 0;
  }

  private static async register(port: chrome.runtime.Port): Promise<void> {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    const context = contexts.find((item) => item.documentId === port.sender?.documentId);
    if (!context || context.windowId < 0 || !context.documentId) {
      port.disconnect();
      return;
    }
    const connection = {
      port,
      windowId: context.windowId,
      documentId: context.documentId,
      tabId: context.tabId,
    };
    SidePanelMode.panels.push(connection);
    port.onMessage.addListener((message) => {
      if (message?.type === "ready") {
        SidePanelMode.deliver(connection.windowId);
      } else if (message?.type === "navigated" && message.accepted === true) {
        const request = SidePanelMode.requests.find(
          (item) => item.id === message.requestId && item.documentId === connection.documentId,
        );
        if (request?.key.startsWith("navigation_")) {
          SidePanelMode.requests = SidePanelMode.requests.filter((item) => item !== request);
          SidePanelMode.deliver(connection.windowId);
          SidePanelMode.updatePendingBadge();
        }
      } else if (
        message?.type === "route" &&
        typeof message.route === "string" &&
        /^\/(?:tabs\/(?:vault|generator|send|settings)|appearance|custom-updates|generator|folders)$/.test(
          message.route,
        )
      ) {
        SidePanelMode.lastRoutes[connection.windowId] = message.route;
        void chrome.storage.session.set({ customSidePanelRoutes: SidePanelMode.lastRoutes });
      } else if (message?.type === "cancel") {
        const request = SidePanelMode.requests.find(
          (item) => item.documentId === connection.documentId,
        );
        if (request) {
          SidePanelMode.finish(request.key, true, request.id);
        }
      }
    });
    port.onDisconnect.addListener(() => SidePanelMode.dropPanel(connection));
    SidePanelMode.sendPanel(connection, {
      type: "connected",
      windowId: connection.windowId,
      route: SidePanelMode.requests.some((item) => item.windowId === connection.windowId)
        ? undefined
        : SidePanelMode.lastRoutes[connection.windowId],
    });
    SidePanelMode.deliver(connection.windowId);
  }

  private static dropPanel(connection: PanelConnection): void {
    SidePanelMode.panels = SidePanelMode.panels.filter((item) => item !== connection);
    for (const request of [...SidePanelMode.requests]) {
      if (request.documentId === connection.documentId) {
        SidePanelMode.finish(request.key, true, request.id);
      }
    }
  }

  private static sendPanel(connection: PanelConnection, message: unknown): void {
    try {
      connection.port.postMessage(message);
    } catch {
      SidePanelMode.dropPanel(connection);
    }
  }

  private static deliver(windowId: number): void {
    const request = SidePanelMode.requests.find((item) => item.windowId === windowId);
    const connections = SidePanelMode.panels.filter((item) => item.windowId === windowId);
    if (!request) {
      return;
    }
    const preferred = connections.find((item) => item.tabId < 0) ?? connections[0];
    if (preferred) {
      request.documentId = preferred.documentId;
      SidePanelMode.sendPanel(preferred, {
        type: "navigate",
        url: request.url,
        requestId: request.id,
        revision: request.revision,
      });
      // Keep navigation queued until the view accepts it; a dirty editor may defer it.
    }
    SidePanelMode.updatePendingBadge();
  }

  private static updatePendingBadge(): void {
    const pending = SidePanelMode.requests.some(
      (request) => !SidePanelMode.panels.some((panel) => panel.windowId === request.windowId),
    );
    if (pending !== SidePanelMode.pendingBadge) {
      SidePanelMode.pendingBadge = pending;
      void chrome.action.setBadgeText({ text: pending ? "!" : "" }).catch((): void => {});
    }
  }

  /** Registers the actual panel document, never a tab displaying an extension URL. */
  static connectView(navigate: (url: string) => Promise<unknown>): () => void {
    if (!SidePanelMode.inPanel(globalThis.window)) {
      return () => undefined;
    }
    let activeRequest: number | undefined;
    let activeRevision: number | undefined;
    let stopFocusing = () => {};
    const lost = () => {
      activeRequest = undefined;
      stopFocusing();
    };
    const port = new ForegroundPort(
      PORT,
      (message) => {
        if (message?.type === "connected") {
          SidePanelMode.lastWindowId = message.windowId;
          if (message.route) {
            void navigate(chrome.runtime.getURL(SIDE_PANEL_PATH) + "#" + message.route);
          }
          port.send({ type: "ready" });
        } else if (
          message?.type === "navigate" &&
          (message.requestId !== activeRequest || message.revision !== activeRevision)
        ) {
          stopFocusing();
          activeRequest = message.requestId;
          activeRevision = message.revision;
          void navigate(message.url)
            .then((result) => {
              if (activeRequest !== message.requestId || activeRevision !== message.revision) {
                return;
              }
              if (
                !port.send({
                  type: "navigated",
                  requestId: message.requestId,
                  accepted: result !== false,
                })
              ) {
                return;
              }
              if (result === false) {
                activeRequest = undefined;
              } else {
                stopFocusing = focusSidePanelUnlock(globalThis.window, message.url);
              }
            })
            .catch(() => {
              activeRequest = undefined;
              port.send({ type: "navigated", requestId: message.requestId, accepted: false });
            });
        } else if (message?.type === "finished" && activeRequest != null) {
          stopFocusing();
          activeRequest = undefined;
          void navigate(chrome.runtime.getURL(SIDE_PANEL_PATH) + "#/tabs/vault");
        }
      },
      lost,
    );
    SidePanelMode.viewPort = port;
    return () => {
      if (SidePanelMode.viewPort === port) {
        SidePanelMode.viewPort = undefined;
      }
      port.dispose();
    };
  }
}
