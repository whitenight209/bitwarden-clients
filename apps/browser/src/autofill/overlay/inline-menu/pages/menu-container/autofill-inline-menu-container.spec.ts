import { AutofillOverlayPort } from "../../../../enums/autofill-overlay.enum";
import { createPortSpyMock } from "../../../../spec/autofill-mocks";
import { postWindowMessage } from "../../../../spec/testing-utils";

import { AutofillInlineMenuContainer } from "./autofill-inline-menu-container";

describe("AutofillInlineMenuContainer", () => {
  const portKey = "testPortKey";
  const extensionOrigin = "chrome-extension://test-extension-id";
  const iframeUrl = `${extensionOrigin}/overlay/menu-list.html`;
  const pageTitle = "Example";
  let autofillInlineMenuContainer: AutofillInlineMenuContainer;

  beforeEach(() => {
    jest.spyOn(chrome.runtime, "getURL").mockReturnValue(`${extensionOrigin}/`);
    autofillInlineMenuContainer = new AutofillInlineMenuContainer();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("initializing the inline menu iframe", () => {
    it("sets the default iframe attributes to the message values", () => {
      const message = {
        command: "initAutofillInlineMenuList",
        iframeUrl,
        pageTitle,
        portKey,
        portName: AutofillOverlayPort.List,
      };

      postWindowMessage(message, extensionOrigin);

      expect(autofillInlineMenuContainer["defaultIframeAttributes"].src).toBe(message.iframeUrl);
      expect(autofillInlineMenuContainer["defaultIframeAttributes"].title).toBe(message.pageTitle);
      expect(autofillInlineMenuContainer["portName"]).toBe(message.portName);
    });

    it("sets up a onLoad listener on the iframe that sets up the background port message listener", async () => {
      const message = {
        command: "initAutofillInlineMenuButton",
        iframeUrl,
        pageTitle,
        portKey,
        portName: AutofillOverlayPort.Button,
      };

      postWindowMessage(message, extensionOrigin);

      jest.spyOn(autofillInlineMenuContainer["inlineMenuPageIframe"].contentWindow, "postMessage");
      autofillInlineMenuContainer["inlineMenuPageIframe"].dispatchEvent(new Event("load"));

      expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: message.portName });
      const expectedMessage = expect.objectContaining({
        ...message,
        token: expect.any(String),
      });
      expect(
        autofillInlineMenuContainer["inlineMenuPageIframe"].contentWindow.postMessage,
      ).toHaveBeenCalledWith(expectedMessage, "*");
    });

    it("ignores initialization when URLs are not from extension origin", () => {
      const invalidIframeUrlMessage = {
        command: "initAutofillInlineMenuList",
        iframeUrl: "https://malicious.com/overlay/menu-list.html",
        pageTitle,
        portKey,
        portName: AutofillOverlayPort.List,
      };

      postWindowMessage(invalidIframeUrlMessage, extensionOrigin);
      expect(autofillInlineMenuContainer["inlineMenuPageIframe"]).toBeUndefined();
      expect(autofillInlineMenuContainer["isInitialized"]).toBe(false);

      autofillInlineMenuContainer = new AutofillInlineMenuContainer();

      const invalidStyleSheetUrlMessage = {
        command: "initAutofillInlineMenuList",
        iframeUrl,
        pageTitle,
        portKey,
        portName: AutofillOverlayPort.List,
        styleSheetUrl: "https://malicious.com/styles.css",
      };

      postWindowMessage(invalidStyleSheetUrlMessage, extensionOrigin);
      expect(autofillInlineMenuContainer["inlineMenuPageIframe"]).toBeUndefined();
      expect(autofillInlineMenuContainer["isInitialized"]).toBe(false);
    });
  });

  describe("handling window messages", () => {
    let iframe: HTMLIFrameElement;
    let port: chrome.runtime.Port;

    beforeEach(() => {
      const message = {
        command: "initAutofillInlineMenuButton",
        iframeUrl,
        pageTitle,
        portKey,
        portName: AutofillOverlayPort.Button,
      };

      postWindowMessage(message, extensionOrigin);

      iframe = autofillInlineMenuContainer["inlineMenuPageIframe"];
      jest.spyOn(iframe.contentWindow, "postMessage");
      port = createPortSpyMock(AutofillOverlayPort.Button);
      autofillInlineMenuContainer["port"] = port;
    });

    it("ignores messages that do not contain a portKey", () => {
      const message = { command: "checkInlineMenuButtonFocused" };

      postWindowMessage(message, "*", iframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it("ignores messages if the inline menu iframe has not been created", () => {
      autofillInlineMenuContainer["inlineMenuPageIframe"] = null;
      const message = { command: "checkInlineMenuButtonFocused", portKey };

      postWindowMessage(message, "*", iframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it("ignores messages that do not come from either the parent frame or the inline menu iframe", () => {
      const randomIframe = document.createElement("iframe");
      const message = { command: "checkInlineMenuButtonFocused", portKey };

      postWindowMessage(message, "*", randomIframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it("ignores messages that come from an invalid origin", () => {
      const message = { command: "checkInlineMenuButtonFocused", portKey };

      postWindowMessage(message, "https://example.com", iframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it("posts a message to the background from the inline menu iframe", () => {
      const token = autofillInlineMenuContainer["token"];
      const message = { command: "checkInlineMenuButtonFocused", portKey, token };

      postWindowMessage(message, "null", iframe.contentWindow as any);

      expect(port.postMessage).toHaveBeenCalledWith(message);
    });

    it.each(["unlockVault", "viewSelectedCipher", "addNewVaultItem"])(
      "sends %s directly to the worker instead of deferring the click through the port",
      async (command) => {
        jest
          .spyOn(chrome.runtime, "sendMessage")
          .mockImplementationOnce(async () => ({ handled: true }));
        const message = { command, portKey, token: autofillInlineMenuContainer["token"] };
        postWindowMessage(message, "null", iframe.contentWindow as any);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          command: "inlineMenuUserNavigation",
          navigation: message,
          portName: port.name,
        });
        await Promise.resolve();
        expect(port.postMessage).not.toHaveBeenCalled();
      },
    );

    it("retains the legacy port path if the direct bridge is unavailable", async () => {
      jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => undefined);
      const message = {
        command: "unlockVault",
        portKey,
        token: autofillInlineMenuContainer["token"],
      };
      postWindowMessage(message, "null", iframe.contentWindow as any);
      await Promise.resolve();
      expect(port.postMessage).toHaveBeenCalledWith(message);
    });

    describe("foreground native unlock refresh", () => {
      let previousSidePanel: PropertyDescriptor | undefined;
      let open: jest.Mock;
      const unlockMessage = () => ({
        command: "unlockVault",
        portKey,
        token: autofillInlineMenuContainer["token"],
      });
      beforeEach(() => {
        previousSidePanel = Object.getOwnPropertyDescriptor(chrome, "sidePanel");
        open = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(chrome, "sidePanel", {
          configurable: true,
          value: { open },
        });
      });
      afterEach(() => {
        if (previousSidePanel) {
          Object.defineProperty(chrome, "sidePanel", previousSidePanel);
        } else {
          delete (chrome as any).sidePanel;
        }
      });

      it("reopens from the runtime response without redispatching the background-owned unlock", async () => {
        jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => ({
          handled: true,
          reopenWindowId: 7,
        }));
        let finishOpen: () => void;
        open.mockImplementation(() => new Promise<void>((resolve) => (finishOpen = resolve)));
        const message = unlockMessage();
        postWindowMessage(message, "null", iframe.contentWindow as any);
        await Promise.resolve();
        expect(open).toHaveBeenCalledWith({ windowId: 7 });
        expect(port.postMessage).not.toHaveBeenCalled();
        finishOpen();
        await Promise.resolve();
        expect(port.postMessage).not.toHaveBeenCalled();
      });

      it("does not duplicate the queued unlock if native reopening rejects", async () => {
        jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => ({
          handled: true,
          reopenWindowId: 7,
        }));
        open.mockRejectedValue(new Error("User activation expired"));
        const message = unlockMessage();
        postWindowMessage(message, "null", iframe.contentWindow as any);
        await Promise.resolve();
        await Promise.resolve();
        expect(port.postMessage).not.toHaveBeenCalled();
      });

      it("does not depend on the originating port surviving native reopening", async () => {
        jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => ({
          handled: true,
          reopenWindowId: 7,
        }));
        jest.spyOn(port, "postMessage").mockImplementation(() => {
          throw new Error("Attempting to use a disconnected port object");
        });
        postWindowMessage(unlockMessage(), "null", iframe.contentWindow as any);
        await Promise.resolve();
        await Promise.resolve();
        expect(port.postMessage).not.toHaveBeenCalled();
      });

      it.each([false, true])(
        "uses the legacy transport fallback once even if the port is disconnected: %s",
        async (disconnected) => {
          jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => {
            throw new Error("Receiving end does not exist");
          });
          if (disconnected) {
            jest.spyOn(port, "postMessage").mockImplementation(() => {
              throw new Error("Attempting to use a disconnected port object");
            });
          }
          const message = unlockMessage();
          postWindowMessage(message, "null", iframe.contentWindow as any);
          await Promise.resolve();
          expect(open).not.toHaveBeenCalled();
          expect(port.postMessage).toHaveBeenCalledTimes(1);
          expect(port.postMessage).toHaveBeenCalledWith(message);
        },
      );

      it.each([-1, 1.5, "7", null, undefined])(
        "does not reopen an invalid target window %s",
        async (windowId) => {
          jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => ({
            handled: true,
            reopenWindowId: windowId,
          }));
          postWindowMessage(unlockMessage(), "null", iframe.contentWindow as any);
          await Promise.resolve();
          expect(open).not.toHaveBeenCalled();
          expect(port.postMessage).not.toHaveBeenCalled();
        },
      );

      it("does not change the foreground behavior of other inline navigation commands", async () => {
        jest.spyOn(chrome.runtime, "sendMessage").mockImplementationOnce(async () => ({
          handled: true,
          reopenWindowId: 7,
        }));
        postWindowMessage(
          { ...unlockMessage(), command: "viewSelectedCipher" },
          "null",
          iframe.contentWindow as any,
        );
        await Promise.resolve();
        expect(open).not.toHaveBeenCalled();
        expect(port.postMessage).not.toHaveBeenCalled();
      });
    });

    it("posts a message to the inline menu iframe from the parent", () => {
      const message = { command: "checkInlineMenuButtonFocused", portKey };

      postWindowMessage(message);

      const expectedMessage = expect.objectContaining({
        ...message,
        token: expect.any(String),
      });
      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(expectedMessage, "*");
    });

    it("ignores messages from iframe with invalid token", () => {
      const message = { command: "checkInlineMenuButtonFocused", portKey, token: "invalid-token" };

      postWindowMessage(message, "null", iframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it("ignores messages from iframe with commands not in the allowlist", () => {
      const token = autofillInlineMenuContainer["token"];
      const message = { command: "maliciousCommand", portKey, token };

      postWindowMessage(message, "null", iframe.contentWindow as any);

      expect(port.postMessage).not.toHaveBeenCalled();
    });
  });

  describe("isExtensionUrlWithOrigin", () => {
    it("validates extension URLs with matching origin", () => {
      const url = "chrome-extension://test-id/path/to/file.html";
      const origin = "chrome-extension://test-id";

      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"](url, origin)).toBe(true);
    });

    it("rejects extension URLs with mismatched origin", () => {
      const url = "chrome-extension://test-id/path/to/file.html";
      const origin = "chrome-extension://different-id";

      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"](url, origin)).toBe(false);
    });

    it("validates extension URL against its own origin when no expectedOrigin provided", () => {
      const url = "moz-extension://test-id/path/to/file.html";

      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"](url)).toBe(true);
    });

    it("rejects non-extension protocols", () => {
      const url = "https://example.com/path";
      const origin = "https://example.com";

      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"](url, origin)).toBe(false);
    });

    it("rejects empty or invalid URLs", () => {
      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"]("")).toBe(false);
      expect(autofillInlineMenuContainer["isExtensionUrlWithOrigin"]("not-a-url")).toBe(false);
    });
  });
});
