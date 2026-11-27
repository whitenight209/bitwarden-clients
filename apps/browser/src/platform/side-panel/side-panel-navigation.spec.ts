import { BrowserApi } from "../browser/browser-api";
import BrowserPopupUtils from "../browser/browser-popup-utils";

import { SidePanelMode } from "./side-panel-mode";

describe("side panel navigation adapters", () => {
  const virtualId = -1_000_123;
  beforeEach(() => {
    jest
      .spyOn(chrome.runtime, "getURL")
      .mockImplementation((path) => "chrome-extension://test/" + path.replace(/^\//, ""));
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    "#/lock",
    "#/login",
    "#/sso?code=abc&state=def",
    "#/2fa",
    "#/fido2?sessionId=one",
    "#/http-authentication?sessionId=one",
    "#/view-cipher?cipherId=one",
    "#/edit-cipher?type=1",
    "#/import",
    "#/autofill-triage",
    "#/at-risk-passwords",
    "#/custom-updates",
  ])("routes existing window entrypoint %s through the shared panel boundary", async (route) => {
    jest.spyOn(SidePanelMode, "open").mockResolvedValue({ id: virtualId } as chrome.windows.Window);
    const create = jest.spyOn(chrome.windows, "create");
    const result = await BrowserApi.createWindow({
      url: `popup/index.html${route}`,
      type: "popup",
    });
    expect(result.id).toBe(virtualId);
    expect(create).not.toHaveBeenCalled();
  });

  test("external websites still open in tabs when panel mode is ON", async () => {
    const open = jest
      .spyOn(SidePanelMode, "open")
      .mockResolvedValue({ id: virtualId } as chrome.windows.Window);
    const previous = chrome.tabs.create;
    const create = jest.fn((_options, callback?) => callback?.({ id: 42 }));
    chrome.tabs.create = create;
    try {
      expect((await BrowserApi.createNewTab("https://example.com/login")).id).toBe(42);
      expect(open).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith(
        { url: "https://example.com/login", active: true },
        expect.any(Function),
      );
    } finally {
      chrome.tabs.create = previous;
    }
  });

  test("OFF preserves native window creation for extension UI", async () => {
    jest.spyOn(SidePanelMode, "open").mockResolvedValue(null);
    const create = jest
      .spyOn(chrome.windows, "create")
      .mockImplementation((_options, callback?) => {
        callback?.({ id: 42 } as chrome.windows.Window);
        return undefined;
      });
    const options = { url: "popup/index.html#/lock", type: "popup" as const };
    expect((await BrowserApi.createWindow(options)).id).toBe(42);
    expect(create).toHaveBeenCalledWith(options, expect.any(Function));
  });

  test("existing popout entrypoints delegate without creating a Chrome window", async () => {
    const opened = jest
      .spyOn(SidePanelMode, "open")
      .mockResolvedValue({ id: virtualId } as chrome.windows.Window);
    const created = jest.spyOn(BrowserApi, "createWindow");
    const options = { senderWindowId: 7, singleActionKey: "authentication" };
    const result = await BrowserPopupUtils.openPopout("popup/index.html#/lock", options);
    expect(opened).toHaveBeenCalledWith("popup/index.html#/lock", options);
    expect(created).not.toHaveBeenCalled();
    expect(result!.id).toBe(virtualId);
  });

  test("internal extension tab entrypoints are routed into the panel", async () => {
    jest
      .spyOn(chrome.runtime, "getURL")
      .mockImplementation((path) => "chrome-extension://test/" + path);
    jest.spyOn(SidePanelMode, "open").mockResolvedValue({ id: virtualId } as chrome.windows.Window);
    const previousCreate = chrome.tabs.create;
    const create = jest.fn();
    chrome.tabs.create = create;
    const tab = await BrowserApi.createNewTab("chrome-extension://test/popup/index.html#/import");
    try {
      expect(tab.windowId).toBe(virtualId);
      expect(create).not.toHaveBeenCalled();
    } finally {
      chrome.tabs.create = previousCreate;
    }
  });

  test("closing a virtual popout never removes its host Chrome window", async () => {
    const close = jest.spyOn(SidePanelMode, "closeVirtual").mockResolvedValue();
    const remove = jest.spyOn(chrome.windows, "remove");
    await BrowserApi.removeWindow(virtualId);
    expect(close).toHaveBeenCalledWith(virtualId);
    expect(remove).not.toHaveBeenCalled();
  });

  test("focusing a virtual popout uses the request broker", async () => {
    const focus = jest.spyOn(SidePanelMode, "focusVirtual").mockResolvedValue();
    await BrowserApi.updateWindowProperties(virtualId, { focused: true });
    expect(focus).toHaveBeenCalledWith(virtualId);
  });

  test("finishing a side panel action closes its request and preserves the panel", () => {
    const close = jest.spyOn(SidePanelMode, "closeKey").mockResolvedValue(true);
    const win = {
      location: {
        href: "chrome-extension://test/popup/index.html?uilocation=sidepanel&singleActionPopout=request_1#/fido2",
      },
      close: jest.fn(),
    } as unknown as Window;
    BrowserApi.closePopup(win);
    expect(close).toHaveBeenCalledWith("request_1");
    expect(win.close).not.toHaveBeenCalled();
  });

  test("closing the ordinary panel does not close a Chrome window", () => {
    const close = jest.spyOn(SidePanelMode, "closeKey").mockResolvedValue(true);
    const win = {
      location: {
        href: "chrome-extension://test/popup/index.html?uilocation=sidepanel#/tabs/vault",
      },
      close: jest.fn(),
    } as unknown as Window;
    BrowserApi.closePopup(win);
    expect(close).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });
});
