import { fakeAsync, TestBed, tick } from "@angular/core/testing";

import { ExtensionPageUrls } from "@bitwarden/common/vault/enums";
import { VaultMessages } from "@bitwarden/common/vault/enums/vault-messages.enum";

import { WebBrowserInteractionService } from "./web-browser-interaction.service";

describe("WebBrowserInteractionService", () => {
  let service: WebBrowserInteractionService;
  const postMessage = jest.fn();
  window.postMessage = postMessage;

  const dispatchEvent = (command: string, requestId?: number) => {
    window.dispatchEvent(
      new MessageEvent("message", { source: window, data: { command, requestId } }),
    );
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [WebBrowserInteractionService],
    });

    postMessage.mockClear();

    service = TestBed.inject(WebBrowserInteractionService);
  });

  describe("extensionInstalled$", () => {
    it("posts a message to check for the extension", () => {
      service.extensionInstalled$.subscribe();

      expect(postMessage).toHaveBeenCalledWith({
        command: VaultMessages.checkBwInstalled,
      });
    });

    it("returns false after the timeout", fakeAsync(() => {
      service.extensionInstalled$.subscribe((installed) => {
        expect(installed).toBe(false);
      });

      tick(501);
    }));

    it("returns true when the extension is installed", (done) => {
      service.extensionInstalled$.subscribe((installed) => {
        expect(installed).toBe(true);
        done();
      });

      dispatchEvent(VaultMessages.HasBwInstalled);
    });

    it("continues to listen for extension state changes after the first response", fakeAsync(() => {
      const results: boolean[] = [];

      service.extensionInstalled$.subscribe((installed) => {
        results.push(installed);
      });

      // initial timeout, should emit false
      tick(501);
      expect(results[0]).toBe(false);

      tick(2500);
      // then emit `HasBwInstalled`
      dispatchEvent(VaultMessages.HasBwInstalled);
      tick(501);
      expect(results[1]).toBe(true);
    }));
  });

  describe("openExtension", () => {
    it("posts a message to open the extension", fakeAsync(() => {
      service.openExtension().catch(() => {});

      expect(postMessage).toHaveBeenCalledWith({
        command: VaultMessages.OpenBrowserExtensionToUrl,
        url: undefined,
        requestId: 1,
      });

      tick(1500);
    }));

    it("posts a message with the passed page", fakeAsync(() => {
      service.openExtension(ExtensionPageUrls.Index).catch(() => {});

      expect(postMessage).toHaveBeenCalledWith({
        command: VaultMessages.OpenBrowserExtensionToUrl,
        url: ExtensionPageUrls.Index,
        requestId: 1,
      });

      tick(1500);
    }));

    it("resolves when the extension opens", async () => {
      const openExtensionPromise = service.openExtension().catch(() => {
        fail();
      });

      dispatchEvent(VaultMessages.PopupOpened);

      await openExtensionPromise;
    });

    it("waits for the acknowledgement for its own request", fakeAsync(() => {
      const first = jest.fn();
      const second = jest.fn();
      void service.openExtension().then(first);
      void service.openExtension(ExtensionPageUrls.AtRiskPasswords).then(second);

      dispatchEvent(VaultMessages.PopupOpened, 2);
      tick();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);

      dispatchEvent(VaultMessages.PopupOpened, 1);
      tick();
      expect(first).toHaveBeenCalledTimes(1);
    }));

    it("rejects if the extension does not open within the timeout", fakeAsync(() => {
      service.openExtension().catch((error) => {
        expect(error).toBe("Failed to open the extension");
      });

      tick(1500);
    }));
  });
});
