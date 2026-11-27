export {};
function mockEvent() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  return {
    listeners,
    addListener: jest.fn((listener) => listeners.push(listener)),
    removeListener: jest.fn(),
    emit: (...args: unknown[]) => listeners.map((listener) => listener(...args)),
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
      setOptions: jest.fn(async () => {}),
      getOptions: jest.fn(async () => ({})),
      setPanelBehavior: jest.fn(async () => {}),
    },
    action: { setPopup: jest.fn(async () => {}), setBadgeText: jest.fn(async () => {}) },
    tabs: { query: jest.fn(async (): Promise<chrome.tabs.Tab[]> => []) },
    windows: {
      getCurrent: jest.fn(async () => ({ id: 7, type: "normal" })),
      get: jest.fn(async () => ({ id: 7, type: "normal" })),
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
  window.history.replaceState(null, "", "/?uilocation=sidepanel#/lock");
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
  window.history.replaceState(null, "", "/?uilocation=sidepanel#/lock");
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
