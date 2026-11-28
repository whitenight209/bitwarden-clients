export {};
function mockEvent() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  return {
    listeners,
    addListener: jest.fn((listener) => listeners.push(listener)),
    removeListener: jest.fn((listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }),
    emit: (...args: unknown[]) => [...listeners].map((listener) => listener(...args)),
  };
}

let api: ReturnType<typeof chromeMock>;
let mode: typeof import("./side-panel-mode").SidePanelMode;
const sender = {
  id: "test-extension",
  url: "chrome-extension://test-extension/popup/index.html",
  documentId: "panel-document",
};

function chromeMock() {
  const onMessage = mockEvent();
  const onConnect = mockEvent();
  return {
    runtime: {
      id: "test-extension",
      onMessage,
      onConnect,
      connect: jest.fn(),
      getURL: (path: string) => "chrome-extension://test-extension/" + path.replace(/^\//, ""),
      getContexts: jest.fn(async () => [
        { contextType: "SIDE_PANEL", windowId: 7, tabId: -1, documentId: "panel-document" },
      ]),
      sendMessage: jest.fn(
        (message) => new Promise((resolve) => onMessage.emit(message, sender, resolve)),
      ),
    },
    storage: {
      local: {
        get: jest.fn(async () => ({ customSidePanelModeEnabled: false })),
        set: jest.fn(async () => {}),
      },
      onChanged: mockEvent(),
    },
    sidePanel: {
      open: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      setOptions: jest.fn(async () => {}),
      getOptions: jest.fn(async () => ({})),
      setPanelBehavior: jest.fn(async () => {}),
    },
    action: { setPopup: jest.fn(async () => {}), setBadgeText: jest.fn(async () => {}) },
    tabs: { query: jest.fn(async (): Promise<chrome.tabs.Tab[]> => []) },
    windows: {
      getCurrent: jest.fn(async () => ({ id: 7, type: "normal" })),
      get: jest.fn(async (id: number) => ({ id, type: "normal" })),
      getLastFocused: jest.fn(async () => ({ id: 7, type: "normal" })),
      update: jest.fn(async () => {}),
      onFocusChanged: mockEvent(),
      onRemoved: mockEvent(),
    },
  };
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.resetModules();
  api = chromeMock();
  Object.defineProperty(globalThis, "chrome", { value: api, configurable: true, writable: true });
  mode = (await import("./side-panel-mode")).SidePanelMode;
  await mode.initializeBackground();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test("defaults to existing popup behavior", () => {
  expect(mode.enabled).toBe(false);
  expect(api.action.setPopup).toHaveBeenLastCalledWith({ popup: "popup/index.html" });
  expect(api.sidePanel.setOptions).toHaveBeenLastCalledWith({
    path: "popup/index.html?uilocation=sidepanel",
    enabled: false,
  });
});

test("ON and OFF persist the preference and configure both native action settings", async () => {
  await mode.setEnabled(true);
  expect(api.action.setPopup).toHaveBeenLastCalledWith({ popup: "" });
  expect(api.sidePanel.setPanelBehavior).toHaveBeenLastCalledWith({ openPanelOnActionClick: true });
  expect(api.sidePanel.setOptions).toHaveBeenLastCalledWith({
    path: "popup/index.html?uilocation=sidepanel",
    enabled: true,
  });
  expect(api.storage.local.set).toHaveBeenLastCalledWith({ customSidePanelModeEnabled: true });
  await mode.setEnabled(false);
  expect(mode.enabled).toBe(false);
  expect(api.action.setPopup).toHaveBeenLastCalledWith({ popup: "popup/index.html" });
  expect(api.sidePanel.setOptions).toHaveBeenLastCalledWith({
    path: "popup/index.html?uilocation=sidepanel",
    enabled: false,
  });
});

test("a cold worker restores the native panel after a lock/reload with the mode ON", async () => {
  jest.resetModules();
  api = chromeMock();
  api.storage.local.get.mockResolvedValue({ customSidePanelModeEnabled: true });
  Object.defineProperty(globalThis, "chrome", { value: api, configurable: true, writable: true });
  mode = (await import("./side-panel-mode")).SidePanelMode;
  await mode.initializeBackground();
  expect(mode.enabled).toBe(true);
  expect(api.sidePanel.setOptions).toHaveBeenLastCalledWith({
    path: "popup/index.html?uilocation=sidepanel",
    enabled: true,
  });
  expect(api.action.setPopup).toHaveBeenLastCalledWith({ popup: "" });
  expect(api.sidePanel.setPanelBehavior).toHaveBeenLastCalledWith({ openPanelOnActionClick: true });
});

test("rolls native settings back if persisting the new preference fails", async () => {
  api.storage.local.set.mockRejectedValueOnce(new Error("Storage unavailable") as never);
  await expect(mode.setEnabled(true)).rejects.toThrow();
  expect(mode.enabled).toBe(false);
  expect(api.action.setPopup).toHaveBeenLastCalledWith({ popup: "popup/index.html" });
});

test("OFF returns null so existing feature-specific windows remain in use", async () => {
  expect(await mode.open("popup/index.html#/login", { senderWindowId: 7 })).toBeNull();
  expect(api.sidePanel.open).not.toHaveBeenCalled();
});

test("ON opens the requesting window and returns a virtual ID, never the real browser window ID", async () => {
  await mode.setEnabled(true);
  const result = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_1",
  });
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  expect(mode.isVirtualWindow(result!.id!)).toBe(true);
  expect(result!.id).not.toBe(7);
});

test("a cold foreground open loads the saved mode and actually attempts to reveal the panel", async () => {
  jest.resetModules();
  api = chromeMock();
  api.storage.local.get.mockResolvedValue({ customSidePanelModeEnabled: true });
  api.runtime.sendMessage.mockImplementation(async () => ({ id: -1_000_001 }));
  Object.defineProperty(globalThis, "chrome", { value: api, configurable: true, writable: true });
  mode = (await import("./side-panel-mode")).SidePanelMode;
  await mode.open("popup/index.html#/lock", { senderWindowId: 7 });
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
});

test("reveal starts synchronously in the originating click and never opens when OFF", async () => {
  expect(mode.reveal(7)).toBeUndefined();
  await mode.setEnabled(true);
  const pending = mode.reveal(7);
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  await pending;
});

test("a locked host refresh waits for real disconnection and keeps authentication queued until its replacement registers", async () => {
  await mode.setEnabled(true);
  await mode.open("popup/index.html#/lock", {
    senderWindowId: 7,
    singleActionKey: "auth_unlockExtension",
  });
  const old = nativePort();
  api.runtime.onConnect.emit(old);
  await settleRegistration();
  const cancelled = jest.fn();
  mode.cancelled$.subscribe(cancelled);
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = old.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  old.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: true });
  await settleRegistration();
  expect(api.sidePanel.close).toHaveBeenCalledWith({ windowId: 7 });
  let closed = false;
  void refreshing.then(() => {
    closed = true;
  });
  await settleRegistration();
  expect(closed).toBe(false);
  api.sidePanel.open.mockClear();
  const opening = mode.open("popup/index.html#/lock", {
    senderWindowId: 7,
    singleActionKey: "auth_unlockExtension",
  });
  const duplicate = mode.prepareUnlockRefresh(7)!;
  await settleRegistration();
  expect(api.sidePanel.open).not.toHaveBeenCalled();
  expect(api.sidePanel.close).toHaveBeenCalledTimes(1);
  old.onDisconnect.emit();
  await expect(refreshing).resolves.toBe(7);
  expect(cancelled).not.toHaveBeenCalled();
  expect(mode.hasRequest("auth_unlockExtension")).toBe(true);
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", documentId: "replacement", windowId: 7, tabId: -1 },
  ]);
  const fresh = nativePort("replacement");
  api.runtime.onConnect.emit(fresh);
  await settleRegistration();
  await expect(opening).resolves.toEqual(expect.objectContaining({ id: expect.any(Number) }));
  await expect(duplicate).resolves.toBeUndefined();
  expect(fresh.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "navigate" }));
  expect(mode.ownsRequest(fresh.sender, "auth_unlockExtension")).toBe(true);
});

test("a pre-opened locked panel queues its first authentication before closing and never refreshes another window", async () => {
  await mode.setEnabled(true);
  const panel = nativePort();
  api.runtime.onConnect.emit(panel);
  await settleRegistration();
  expect(mode.prepareUnlockRefresh(8)).toBeUndefined();
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = panel.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  panel.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: true });
  await settleRegistration();
  expect(mode.hasRequest("auth_unlockExtension")).toBe(true);
  expect(api.sidePanel.close).toHaveBeenCalledWith({ windowId: 7 });
  panel.onDisconnect.emit();
  await expect(refreshing).resolves.toBe(7);
});

test("refresh waits for both the native closed event and document disconnection when Chrome exposes onClosed", async () => {
  const onClosed = mockEvent();
  Object.assign(api.sidePanel, { onClosed });
  await mode.setEnabled(true);
  const panel = nativePort();
  api.runtime.onConnect.emit(panel);
  await settleRegistration();
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = panel.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  panel.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: true });
  await settleRegistration();
  panel.onDisconnect.emit();
  let completed = false;
  void refreshing.then(() => {
    completed = true;
  });
  await settleRegistration();
  expect(completed).toBe(false);
  onClosed.emit({ windowId: 8 });
  await settleRegistration();
  expect(completed).toBe(false);
  onClosed.emit({ windowId: 7 });
  await expect(refreshing).resolves.toBe(7);
});

test("normal popup mode does not require a Side Panel API", () => {
  Object.defineProperty(globalThis, "chrome", {
    value: { ...api, sidePanel: undefined },
    configurable: true,
    writable: true,
  });
  expect(mode.prepareUnlockRefresh(7)).toBeUndefined();
});

test("editing or another authentication request never closes a native panel", async () => {
  await mode.setEnabled(true);
  const panel = nativePort();
  api.runtime.onConnect.emit(panel);
  await settleRegistration();
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = panel.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  panel.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: false });
  await expect(refreshing).resolves.toBeUndefined();
  expect(api.sidePanel.close).not.toHaveBeenCalled();
  await mode.open("popup/index.html#/fido2", { senderWindowId: 7, singleActionKey: "fido_1" });
  expect(mode.prepareUnlockRefresh(7)).toBeUndefined();
  expect(api.sidePanel.close).not.toHaveBeenCalled();
});

test("an unresponsive lock check expires without closing or stranding later requests", async () => {
  await mode.setEnabled(true);
  const panel = nativePort();
  api.runtime.onConnect.emit(panel);
  await settleRegistration();
  const refreshing = mode.prepareUnlockRefresh(7)!;
  await jest.advanceTimersByTimeAsync(10_000);
  await expect(refreshing).resolves.toBeUndefined();
  expect(api.sidePanel.close).not.toHaveBeenCalled();
  api.sidePanel.open.mockClear();
  await mode.reveal(7);
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
});

test("a late disconnect after the close deadline cannot cancel authentication or rebind it to the retired document", async () => {
  await mode.setEnabled(true);
  const original = await mode.open("popup/index.html#/lock", {
    senderWindowId: 7,
    singleActionKey: "auth_unlockExtension",
  });
  const old = nativePort();
  api.runtime.onConnect.emit(old);
  await settleRegistration();
  const cancelled = jest.fn();
  mode.cancelled$.subscribe(cancelled);
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = old.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  old.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: true });
  await settleRegistration();
  await jest.advanceTimersByTimeAsync(10_000);
  await expect(refreshing).resolves.toBeUndefined();
  expect(mode.ownsRequest(old.sender, "auth_unlockExtension")).toBe(false);
  old.onDisconnect.emit();
  expect(cancelled).not.toHaveBeenCalled();
  expect(mode.hasRequest("auth_unlockExtension")).toBe(true);
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", documentId: "late-replacement", windowId: 7, tabId: -1 },
  ]);
  const fresh = nativePort("late-replacement");
  api.runtime.onConnect.emit(fresh);
  await settleRegistration();
  expect(fresh.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: original!.id }),
  );
  expect(mode.ownsRequest(fresh.sender, "auth_unlockExtension")).toBe(true);
});

test("a rejected close restores the live verified document and normal cancellation", async () => {
  await mode.setEnabled(true);
  const panel = nativePort();
  api.runtime.onConnect.emit(panel);
  await settleRegistration();
  api.sidePanel.close.mockRejectedValueOnce(new Error("Close unavailable"));
  const refreshing = mode.prepareUnlockRefresh(7)!;
  const check = panel.postMessage.mock.calls.find(
    ([message]) => message.type === "checkUnlockRefresh",
  )![0];
  panel.onMessage.emit({ type: "unlockRefreshReady", id: check.id, ready: true });
  await expect(refreshing).resolves.toBeUndefined();
  expect(mode.ownsRequest(panel.sender, "auth_unlockExtension")).toBe(true);
  panel.onDisconnect.emit();
  expect(mode.hasRequest("auth_unlockExtension")).toBe(false);
});

test("the registered view permits refresh only on a lock screen without an active dialog", () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const screen = document.body.appendChild(document.createElement("div"));
  screen.dataset.testid = "lock-screen";
  const port = nativePort();
  api.runtime.connect.mockReturnValue(port);
  const navigate = jest.fn();
  const cleanup = mode.connectView(navigate);
  try {
    port.onMessage.emit({ type: "checkUnlockRefresh", id: 1 });
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "unlockRefreshReady",
      id: 1,
      ready: true,
    });
    const dialog = screen.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    port.onMessage.emit({ type: "checkUnlockRefresh", id: 2 });
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "unlockRefreshReady",
      id: 2,
      ready: false,
    });
    dialog.remove();
    window.history.replaceState(null, "", window.location.href.replace("#/lock", "#/edit-cipher"));
    port.onMessage.emit({ type: "checkUnlockRefresh", id: 3 });
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "unlockRefreshReady",
      id: 3,
      ready: false,
    });
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    cleanup();
    screen.remove();
    window.history.replaceState(null, "", original);
  }
});

test("a denied user gesture leaves a queued request instead of opening a fallback popout", async () => {
  await mode.setEnabled(true);
  api.sidePanel.open.mockRejectedValueOnce(new Error("User gesture required") as never);
  const result = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_1",
  });
  expect(result?.id).toBeDefined();
  expect(mode.hasRequest("fido_1")).toBe(true);
});

test("a queued passkey can open the panel from its own top-level tab click only", async () => {
  await mode.setEnabled(true);
  api.sidePanel.open.mockRejectedValueOnce(new Error("User gesture required") as never);
  await mode.open("popup/index.html#/fido2?sessionId=one&senderTabId=42", {
    senderWindowId: 7,
    singleActionKey: "vault_Fido2Popout_one",
  });
  api.sidePanel.open.mockClear();
  const sender = { id: api.runtime.id, frameId: 0, tab: { id: 42, windowId: 7 } };
  expect(
    mode.revealPasskeyRequest("one", { ...sender, frameId: 1 } as chrome.runtime.MessageSender),
  ).toBeUndefined();
  expect(
    mode.revealPasskeyRequest("one", {
      ...sender,
      tab: { id: 44, windowId: 7 },
    } as chrome.runtime.MessageSender),
  ).toBeUndefined();
  expect(
    mode.revealPasskeyRequest("missing", sender as chrome.runtime.MessageSender),
  ).toBeUndefined();
  expect(api.sidePanel.open).not.toHaveBeenCalled();

  const opening = mode.revealPasskeyRequest("one", sender as chrome.runtime.MessageSender);
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  await opening;

  await mode.closeKey("vault_Fido2Popout_one");
  expect(mode.revealPasskeyRequest("one", sender as chrome.runtime.MessageSender)).toBeUndefined();
});

test("pending authentication blocks a mode switch until it finishes", async () => {
  await mode.setEnabled(true);
  await mode.open("popup/index.html#/fido2", { senderWindowId: 7, singleActionKey: "fido_1" });
  await expect(mode.setEnabled(false)).rejects.toThrow(/Finish/);
  await mode.closeKey("fido_1");
  await expect(mode.setEnabled(false)).resolves.toBeUndefined();
});

test.each([
  "https://evil.example/popup/index.html",
  "chrome-extension://other/popup/index.html",
  "file:///popup/index.html",
  "popup/other.html",
])("refuses foreign UI path %s", (url) => expect(() => mode.panelUrl(url)).toThrow());

test("website content scripts cannot change the mode through internal messages", () => {
  const respond = jest.fn();
  api.runtime.onMessage.emit(
    { customSidePanel: "setMode", enabled: true },
    { ...sender, url: "https://example.test" },
    respond,
  );
  expect(respond).not.toHaveBeenCalled();
  expect(mode.enabled).toBe(false);
});

test("only the registered document owns a delivered request and closing the panel cancels it", async () => {
  await mode.setEnabled(true);
  const request = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_1",
  });
  const port = {
    name: "customSidePanelView",
    sender,
    onMessage: mockEvent(),
    onDisconnect: mockEvent(),
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
  api.runtime.onConnect.emit(port);
  await Promise.resolve();
  await Promise.resolve();
  expect(mode.ownsRequest(sender, "fido_1")).toBe(true);
  expect(mode.ownsRequest({ ...sender, documentId: "another-document" }, "fido_1")).toBe(false);
  const cancelled = jest.fn();
  mode.cancelled$.subscribe(cancelled);
  port.onDisconnect.emit();
  expect(cancelled).toHaveBeenCalledWith(request!.id);
  expect(mode.hasRequest("fido_1")).toBe(false);
});

test("a request expires and notifies its waiting authentication session", async () => {
  await mode.setEnabled(true);
  const request = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_1",
  });
  const cancelled = jest.fn();
  mode.cancelled$.subscribe(cancelled);
  jest.advanceTimersByTime(121_000);
  expect(cancelled).toHaveBeenCalledWith(request!.id);
  expect(mode.hasRequest("fido_1")).toBe(false);
});

test("storage change events propagate the mode to other extension contexts", () => {
  api.storage.onChanged.emit({ customSidePanelModeEnabled: { newValue: true } }, "local");
  expect(mode.enabled).toBe(true);
});

test("closing one virtual request preserves an identical key in another browser window", async () => {
  await mode.setEnabled(true);
  const first = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_shared",
  });
  const second = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 8,
    singleActionKey: "fido_shared",
  });
  await mode.closeVirtual(first!.id!);
  expect(mode.hasRequest("fido_shared")).toBe(true);
  await mode.closeVirtual(second!.id!);
  expect(mode.hasRequest("fido_shared")).toBe(false);
});

test("closing a Chrome window cancels only its own request", async () => {
  await mode.setEnabled(true);
  const first = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "fido_shared",
  });
  const second = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 8,
    singleActionKey: "fido_shared",
  });
  const cancelled = jest.fn();
  mode.cancelled$.subscribe(cancelled);
  api.windows.onRemoved.emit(7);
  expect(cancelled).toHaveBeenCalledWith(first!.id);
  expect(cancelled).not.toHaveBeenCalledWith(second!.id);
  expect(mode.hasRequest("fido_shared")).toBe(true);
});

test("ordinary navigation does not block switching the mode off", async () => {
  await mode.setEnabled(true);
  await mode.open("popup/index.html#/tabs/settings", { senderWindowId: 7 });
  await expect(mode.setEnabled(false)).resolves.toBeUndefined();
});

test("a foreground request carries its own browser window through IPC", async () => {
  jest.resetModules();
  const foreground = (await import("./side-panel-mode")).SidePanelMode;
  api.storage.local.get.mockResolvedValue({ customSidePanelModeEnabled: true });
  api.runtime.sendMessage.mockImplementation(async () => ({ id: -1_000_005 }));
  await foreground.ready();
  await foreground.open("popup/index.html#/generator");
  expect(api.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ options: { senderWindowId: 7 } }),
  );
});

test("navigation remains queued until its own panel accepts it after editing", async () => {
  await mode.setEnabled(true);
  const request = await mode.open("popup/index.html#/generator", {
    senderWindowId: 7,
    singleActionKey: "navigation_deferred",
  });
  const port = {
    name: "customSidePanelView",
    sender,
    onMessage: mockEvent(),
    onDisconnect: mockEvent(),
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
  api.runtime.onConnect.emit(port);
  await Promise.resolve();
  await Promise.resolve();
  port.onMessage.emit({ type: "navigated", requestId: request!.id, accepted: false });
  expect(mode.hasRequest("navigation_deferred")).toBe(true);
  port.onMessage.emit({ type: "ready" });
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "navigate", requestId: request!.id }),
  );
  port.onMessage.emit({ type: "navigated", requestId: request!.id, accepted: true });
  expect(mode.hasRequest("navigation_deferred")).toBe(false);
});

test("confirms a navigation only after its own window's panel accepts it", async () => {
  await mode.setEnabled(true);
  const contexts = await api.runtime.getContexts();
  api.runtime.getContexts.mockResolvedValue([
    ...contexts,
    { contextType: "SIDE_PANEL", windowId: 8, tabId: -1, documentId: "second-panel" },
  ]);
  const attach = (documentId: string) => {
    const port = {
      name: "customSidePanelView",
      sender: { ...sender, documentId },
      onMessage: mockEvent(),
      onDisconnect: mockEvent(),
      postMessage: jest.fn(),
      disconnect: jest.fn(),
    };
    api.runtime.onConnect.emit(port);
    return port;
  };

  const first = attach(sender.documentId);
  const settled = jest.fn();
  const confirmation = mode.openAndConfirm("popup/index.html#/generator", 8).then(settled);
  await jest.advanceTimersByTimeAsync(0);
  const second = attach("second-panel");
  await jest.advanceTimersByTimeAsync(0);
  const [navigation] = second.postMessage.mock.calls.find(
    ([message]) => message.type === "navigate",
  )!;
  const accepted = { type: "navigated", requestId: navigation.requestId, accepted: true };
  first.onMessage.emit(accepted);
  second.onMessage.emit({ ...accepted, accepted: false });
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();

  second.onMessage.emit(accepted);
  await confirmation;
  expect(settled).toHaveBeenCalledWith(true);
  expect(first.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "navigate" }));
});

test("leaves a timed-out confirmation queued for the toolbar", async () => {
  await mode.setEnabled(true);
  api.sidePanel.open.mockRejectedValueOnce(new Error("User gesture required") as never);
  const confirmation = mode.openAndConfirm("popup/index.html#/generator", 7);
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(confirmation).resolves.toBe(false);

  const port = {
    name: "customSidePanelView",
    sender,
    onMessage: mockEvent(),
    onDisconnect: mockEvent(),
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
  api.runtime.onConnect.emit(port);
  await jest.advanceTimersByTimeAsync(0);
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "navigate", url: expect.stringContaining("#/generator") }),
  );
});

test("a repeated unlock request in the same window receives a new focus revision", async () => {
  await mode.setEnabled(true);
  const options = { senderWindowId: 7, singleActionKey: "auth_unlockExtension" };
  const first = await mode.open("popup/index.html#/lock", options);
  const port = {
    name: "customSidePanelView",
    sender,
    onMessage: mockEvent(),
    onDisconnect: mockEvent(),
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
  api.runtime.onConnect.emit(port);
  await Promise.resolve();
  await Promise.resolve();
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "navigate", requestId: first!.id, revision: 0 }),
  );
  const again = await mode.open("popup/index.html#/lock", options);
  expect(again!.id).toBe(first!.id);
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "navigate", requestId: first!.id, revision: 1 }),
  );
});

test("a panel refocuses only for a fresh explicit request, and cancels focus on completion", async () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const stop = jest.fn();
  const helper = await import("./side-panel-unlock-focus");
  const focus = jest.spyOn(helper, "focusSidePanelUnlock").mockReturnValue(stop);
  const port = { onMessage: mockEvent(), postMessage: jest.fn(), disconnect: jest.fn() };
  api.runtime.connect.mockReturnValue(port);
  const navigate = jest.fn(async () => true);
  const cleanup = mode.connectView(navigate);
  const message = {
    type: "navigate",
    requestId: -1_000_001,
    revision: 0,
    url: "chrome-extension://test-extension/popup/index.html?uilocation=sidepanel&singleActionPopout=auth_unlockExtension#/lock",
  };
  try {
    port.onMessage.emit(message);
    await Promise.resolve();
    expect(focus).toHaveBeenCalledTimes(1);
    port.onMessage.emit(message);
    await Promise.resolve();
    expect(focus).toHaveBeenCalledTimes(1);
    port.onMessage.emit({ ...message, revision: 1 });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(2);
    port.onMessage.emit({ type: "finished" });
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    focus.mockRestore();
    window.history.replaceState(null, "", original);
  }
});

test("a disposed panel never starts focusing after an in-flight navigation resolves", async () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const helper = await import("./side-panel-unlock-focus");
  const focus = jest.spyOn(helper, "focusSidePanelUnlock").mockReturnValue(jest.fn());
  const port = { onMessage: mockEvent(), postMessage: jest.fn(), disconnect: jest.fn() };
  api.runtime.connect.mockReturnValue(port);
  let finish!: (accepted: boolean) => void;
  const cleanup = mode.connectView(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    port.onMessage.emit({
      type: "navigate",
      requestId: -1_000_001,
      revision: 0,
      url: "chrome-extension://test-extension/popup/index.html?uilocation=sidepanel&singleActionPopout=auth_unlockExtension#/lock",
    });
    cleanup();
    finish(true);
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
    window.history.replaceState(null, "", original);
  }
});

function nativePort(documentId: string | undefined = sender.documentId) {
  return {
    name: "customSidePanelView",
    sender: { ...sender, documentId },
    onMessage: mockEvent(),
    onDisconnect: mockEvent(),
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
}

async function settleRegistration() {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
  }
}

async function askForWindow(port: ReturnType<typeof nativePort>) {
  api.runtime.onConnect.emit(port);
  await settleRegistration();
  const identify = port.postMessage.mock.calls.find(
    ([message]) => message.type === "identifyWindow",
  )?.[0];
  expect(identify).toEqual({ type: "identifyWindow", requestId: expect.any(Number) });
  return identify.requestId;
}

test("a verified native panel with windowId -1 identifies its own owner before receiving requests", async () => {
  await mode.setEnabled(true);
  const request = await mode.open("popup/index.html#/lock", {
    senderWindowId: 7,
    singleActionKey: "auth_unlockExtension",
  });
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  api.windows.getLastFocused.mockClear();
  const port = nativePort();
  const requestId = await askForWindow(port);
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "navigate" }));
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await settleRegistration();
  expect(api.windows.get).toHaveBeenCalledWith(7);
  expect(api.windows.getLastFocused).not.toHaveBeenCalled();
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "connected", windowId: 7 }),
  );
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: request!.id }),
  );
  expect(mode.ownsRequest(sender, "auth_unlockExtension")).toBe(true);
});

const token7 = "bdf45d95-b10e-4d60-b154-779d36310a07";
const token8 = "bdf45d95-b10e-4d60-b154-779d36310a08";
function tokenPanel(token = token7, documentId = "native-document7") {
  const url = `${sender.url}?uilocation=sidepanel&sidePanelDocument=${token}#/lock`;
  const port = nativePort();
  port.sender = { ...sender, documentId: undefined, url };
  return {
    port,
    context: { contextType: "SIDE_PANEL", documentId, documentUrl: url, windowId: -1, tabId: -1 },
  };
}

test.each(["#/lock", "#/startup"])(
  "a native panel without sender.documentId verifies committed identity despite SPA route %s and can finish authentication",
  async (fragment) => {
    await mode.setEnabled(true);
    const request = await mode.open("popup/index.html#/lock", {
      senderWindowId: 7,
      singleActionKey: "auth_unlockExtension",
    });
    const { port, context } = tokenPanel();
    context.documentUrl = context.documentUrl
      .replace("#/lock", fragment)
      .replace(
        "uilocation=sidepanel",
        "uilocation=sidepanel&singleActionPopout=auth_unlockExtension",
      );
    api.runtime.getContexts.mockResolvedValue([context]);
    const requestId = await askForWindow(port);
    port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
    await settleRegistration();
    expect(mode.ownsRequest(port.sender, "auth_unlockExtension")).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "navigate", requestId: request!.id }),
    );
    const response = await new Promise((resolve) =>
      api.runtime.onMessage.emit(
        { customSidePanel: "close", key: "auth_unlockExtension" },
        port.sender,
        resolve,
      ),
    );
    expect(response).toEqual({ closed: true });
    expect(mode.hasRequest("auth_unlockExtension")).toBe(false);
  },
);

test("missing-documentId panels in two windows keep authentication ownership separate", async () => {
  await mode.setEnabled(true);
  const first = await mode.open("popup/index.html#/lock", {
    senderWindowId: 7,
    singleActionKey: "auth7",
  });
  await mode.open("popup/index.html#/lock", { senderWindowId: 8, singleActionKey: "auth8" });
  const panel7 = tokenPanel();
  const panel8 = tokenPanel(token8, "native-document8");
  api.runtime.getContexts.mockResolvedValue([panel7.context, panel8.context]);
  const id7 = await askForWindow(panel7.port);
  const id8 = await askForWindow(panel8.port);
  panel8.port.onMessage.emit({ type: "identifiedWindow", requestId: id8, windowId: 8 });
  panel7.port.onMessage.emit({ type: "identifiedWindow", requestId: id7, windowId: 7 });
  await settleRegistration();
  expect(mode.ownsRequest(panel7.port.sender, "auth7")).toBe(true);
  expect(mode.ownsRequest(panel7.port.sender, "auth8")).toBe(false);
  const response = await new Promise((resolve) =>
    api.runtime.onMessage.emit(
      { customSidePanel: "close", key: "auth8" },
      panel7.port.sender,
      resolve,
    ),
  );
  expect(response).toEqual({ closed: false });
  expect(mode.hasRequest("auth8")).toBe(true);
  await new Promise((resolve) =>
    api.runtime.onMessage.emit(
      { customSidePanel: "closeVirtual", windowId: first!.id },
      panel7.port.sender,
      resolve,
    ),
  );
  expect(mode.hasRequest("auth7")).toBe(false);
  expect(mode.hasRequest("auth8")).toBe(true);
});

test.each([
  "wrong-token",
  "different-path",
  "different-location",
  "ordinary-tab",
  "wrong-documentId",
  "duplicate-contexts",
  "non-panel-context",
])("rejects missing-documentId fallback for %s", async (reason) => {
  const { port, context } = tokenPanel();
  if (reason === "wrong-token") {
    context.documentUrl = tokenPanel(token8).context.documentUrl;
  }
  if (reason === "different-path") {
    context.documentUrl = context.documentUrl.replace("popup/index.html", "other/index.html");
  }
  if (reason === "different-location") {
    context.documentUrl = context.documentUrl.replace("uilocation=sidepanel", "uilocation=tab");
  }
  if (reason === "ordinary-tab") {
    Object.assign(port.sender, { tab: { id: 3 } });
  }
  if (reason === "wrong-documentId") {
    port.sender.documentId = "different-document";
  }
  if (reason === "non-panel-context") {
    context.contextType = "TAB";
  }
  api.runtime.getContexts.mockResolvedValue(
    reason === "duplicate-contexts"
      ? [context, { ...context, documentId: "duplicate" }]
      : [context],
  );
  api.runtime.onConnect.emit(port);
  await settleRegistration();
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.postMessage).not.toHaveBeenCalled();
  expect(mode.ownsRequest(port.sender, "auth_unlockExtension")).toBe(false);
});

test.each(["", "&sidePanelDocument=invalid"])(
  "a native panel commits identity before rendering and never reloads an identified document (%s)",
  (suffix) => {
    const replace = jest.fn();
    const location = { href: `${sender.url}?uilocation=sidepanel${suffix}#/lock`, replace };
    const win = { location } as unknown as Window;
    expect(mode.prepareViewDocument(win)).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    const committed = new URL(replace.mock.calls[0][0]);
    expect(committed.searchParams.get("sidePanelDocument")).toMatch(/^[\da-f-]{36}$/);
    expect(committed.searchParams.get("uilocation")).toBe("sidepanel");
    expect(committed.hash).toBe("#/lock");
    location.href = committed.href;
    expect(mode.prepareViewDocument(win)).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
  },
);

test("normal popup documents render immediately without changing their URL", () => {
  const replace = jest.fn();
  const win = { location: { href: sender.url, replace } } as unknown as Window;
  expect(mode.prepareViewDocument(win)).toBe(true);
  expect(replace).not.toHaveBeenCalled();
});

test("the native view reuses its committed identity when connecting and preserves it through every navigation", async () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const port = nativePort();
  let connectedToken: string | null = null;
  api.runtime.connect.mockImplementation(() => {
    connectedToken = new URL(window.location.href).searchParams.get("sidePanelDocument");
    return port;
  });
  const navigate = jest.fn(async () => true);
  const cleanup = mode.connectView(navigate);
  try {
    expect(connectedToken).toMatch(/^[\da-f-]{36}$/);
    port.onMessage.emit({ type: "connected", windowId: 7, route: "/tabs/vault" });
    port.onMessage.emit({
      type: "navigate",
      requestId: -1_000_001,
      revision: 0,
      url: `${sender.url}?uilocation=sidepanel&singleActionPopout=auth_unlockExtension#/lock`,
    });
    await settleRegistration();
    port.onMessage.emit({ type: "finished" });
    expect(navigate).toHaveBeenCalledTimes(3);
    for (const [href] of navigate.mock.calls as unknown as Array<[string]>) {
      expect(new URL(href).searchParams.get("sidePanelDocument")).toBe(connectedToken);
    }
  } finally {
    cleanup();
    window.history.replaceState(null, "", original);
  }
});

test("two unidentified panels keep their reported windows separate even when their replies arrive in reverse order", async () => {
  await mode.setEnabled(true);
  const first = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 7,
    singleActionKey: "window7",
  });
  const second = await mode.open("popup/index.html#/fido2", {
    senderWindowId: 8,
    singleActionKey: "window8",
  });
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: "document7" },
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: "document8" },
  ]);
  api.windows.get.mockImplementation(async (id: number) => ({ id, type: "normal" }));
  api.windows.getLastFocused.mockClear();
  const one = nativePort("document7");
  const two = nativePort("document8");
  const oneId = await askForWindow(one);
  const twoId = await askForWindow(two);
  two.onMessage.emit({ type: "identifiedWindow", requestId: twoId, windowId: 8 });
  one.onMessage.emit({ type: "identifiedWindow", requestId: oneId, windowId: 7 });
  await settleRegistration();
  expect(one.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: first!.id }),
  );
  expect(one.postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: second!.id }),
  );
  expect(two.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: second!.id }),
  );
  expect(two.postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "navigate", requestId: first!.id }),
  );
  expect(api.windows.getLastFocused).not.toHaveBeenCalled();
});

test.each([-1, 1.5, NaN, "7", undefined])(
  "rejects an invalid identified owner %s without falling back to another window",
  async (windowId) => {
    api.runtime.getContexts.mockResolvedValue([
      { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
    ]);
    const port = nativePort();
    const requestId = await askForWindow(port);
    api.windows.getLastFocused.mockClear();
    port.onMessage.emit({ type: "identifiedWindow", requestId, windowId });
    await settleRegistration();
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "connected" }),
    );
    expect(api.windows.getLastFocused).not.toHaveBeenCalled();
  },
);

test.each(["popup", "missing"])("rejects an identified %s window", async (type) => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  if (type === "missing") {
    api.windows.get.mockRejectedValue(new Error("No such window") as never);
  } else {
    api.windows.get.mockResolvedValue({ id: 7, type });
  }
  const port = nativePort();
  const requestId = await askForWindow(port);
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await settleRegistration();
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
});

test("only the matching identification response can complete a registration", async () => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  const port = nativePort();
  const requestId = await askForWindow(port);
  port.onMessage.emit({ type: "identifiedWindow", requestId: requestId + 1, windowId: 7 });
  await settleRegistration();
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await settleRegistration();
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "connected", windowId: 7 }),
  );
});

test("an identification timeout removes its listeners and ignores late replies", async () => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  const timers = jest.getTimerCount();
  const port = nativePort();
  const requestId = await askForWindow(port);
  await jest.advanceTimersByTimeAsync(5000);
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.onMessage.listeners).toHaveLength(0);
  expect(port.onDisconnect.listeners).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(timers);
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await settleRegistration();
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
});

test("disconnecting while identification is pending clears the timeout and cannot register later", async () => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  const timers = jest.getTimerCount();
  const port = nativePort();
  const requestId = await askForWindow(port);
  port.onDisconnect.emit();
  await settleRegistration();
  expect(jest.getTimerCount()).toBe(timers);
  expect(port.onMessage.listeners).toHaveLength(0);
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await jest.advanceTimersByTimeAsync(5000);
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
});

test("a disconnect before native-context lookup finishes prevents a later identity request", async () => {
  let finish!: (
    contexts: Array<{ contextType: string; windowId: number; tabId: number; documentId: string }>,
  ) => void;
  api.runtime.getContexts.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const port = nativePort();
  api.runtime.onConnect.emit(port);
  expect(port.onDisconnect.listeners).toHaveLength(1);
  port.onDisconnect.emit();
  finish([{ contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId }]);
  await settleRegistration();
  expect(port.postMessage).not.toHaveBeenCalled();
  expect(port.onMessage.listeners).toHaveLength(0);
});

test("a normal tab cannot identify itself as a panel even when it supplies an existing normal window", async () => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "TAB", windowId: 7, tabId: 3, documentId: sender.documentId },
  ]);
  const port = nativePort();
  api.runtime.onConnect.emit(port);
  await settleRegistration();
  port.onMessage.emit({ type: "identifiedWindow", requestId: 1, windowId: 7 });
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(port.postMessage).not.toHaveBeenCalled();
});

test("an already-known native window skips identification", async () => {
  const port = nativePort();
  api.runtime.onConnect.emit(port);
  await settleRegistration();
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "connected", windowId: 7 }),
  );
  expect(port.postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "identifyWindow" }),
  );
});

test("the native view reports its own current window through the identification handshake", async () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const port = nativePort();
  api.runtime.connect.mockReturnValue(port);
  api.windows.getCurrent.mockResolvedValue({ id: 8, type: "normal" });
  api.windows.getLastFocused.mockClear();
  const cleanup = mode.connectView(jest.fn());
  try {
    port.onMessage.emit({ type: "identifyWindow", requestId: 17 });
    await settleRegistration();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "identifiedWindow",
      requestId: 17,
      windowId: 8,
    });
    expect(api.windows.getLastFocused).not.toHaveBeenCalled();
  } finally {
    cleanup();
    window.history.replaceState(null, "", original);
  }
});

test("a disposed view never sends an in-flight window identity to a new connection", async () => {
  const original = window.location.href;
  window.history.replaceState(
    null,
    "",
    "/?uilocation=sidepanel&sidePanelDocument=bdf45d95-b10e-4d60-b154-779d36310a07#/lock",
  );
  const port = nativePort();
  api.runtime.connect.mockReturnValue(port);
  let finish!: (owner: { id: number; type: string }) => void;
  api.windows.getCurrent.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cleanup = mode.connectView(jest.fn());
  port.onMessage.emit({ type: "identifyWindow", requestId: 18 });
  cleanup();
  finish({ id: 8, type: "normal" });
  await settleRegistration();
  expect(port.postMessage).not.toHaveBeenCalled();
  window.history.replaceState(null, "", original);
});

test("window validation is bounded by the registration deadline and ignores a late successful lookup", async () => {
  api.runtime.getContexts.mockResolvedValue([
    { contextType: "SIDE_PANEL", windowId: -1, tabId: -1, documentId: sender.documentId },
  ]);
  let finish!: (owner: { id: number; type: string }) => void;
  api.windows.get.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const port = nativePort();
  const requestId = await askForWindow(port);
  port.onMessage.emit({ type: "identifiedWindow", requestId, windowId: 7 });
  await settleRegistration();
  await jest.advanceTimersByTimeAsync(5000);
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  finish({ id: 7, type: "normal" });
  await settleRegistration();
  expect(port.onMessage.listeners).toHaveLength(0);
  expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connected" }));
});
