import { BrowserContext, CDPSession, Page, expect } from "@playwright/test";

/** Opens a real native side panel with a trusted mouse click, not an extension URL in a tab. */
export async function openNativeSidePanel(page: Page, windowId?: number): Promise<number> {
  const owner =
    windowId ?? (await page.evaluate(async () => (await chrome.windows.getCurrent()).id!));
  await page.evaluate((id) => {
    document.getElementById("e2e-open-native-panel")?.remove();
    const button = document.createElement("button");
    button.id = "e2e-open-native-panel";
    button.textContent = "Open native test panel";
    button.style.cssText =
      "position:fixed;top:0;left:0;z-index:2147483647;background:white;color:black;padding:12px";
    button.onclick = () => {
      void chrome.sidePanel.open({ windowId: id }).then(
        () => {
          button.dataset.result = "opened";
        },
        (error: unknown) => {
          button.dataset.result = String(error);
        },
      );
    };
    document.body.append(button);
  }, owner);
  await page.locator("#e2e-open-native-panel").click();
  await expect(page.locator("#e2e-open-native-panel")).toHaveAttribute("data-result", "opened");
  return owner;
}

/** CDP is needed because a native panel may not appear in Playwright context.pages(). */
export class NativeSidePanel {
  private sequence = 0;
  private disposed = false;
  private constructor(
    private cdp: CDPSession,
    private sessionId: string,
    readonly targetId: string,
  ) {}

  static async attach(
    context: BrowserContext,
    page: Page,
    windowId: number,
    replacedTargetId?: string,
  ): Promise<NativeSidePanel> {
    const cdp = await context.newCDPSession(page);
    let panel: NativeSidePanel | undefined;
    try {
      await expect
        .poll(
          async () => {
            const { targetInfos } = await cdp.send("Target.getTargets");
            for (const target of targetInfos) {
              if (
                target.targetId === replacedTargetId ||
                !target.url.startsWith("chrome-extension://") ||
                !target.url.includes("sidePanelDocument=")
              ) {
                continue;
              }
              const connection = await cdp
                .send("Target.attachToTarget", { targetId: target.targetId, flatten: false })
                .catch((): undefined => undefined);
              if (!connection) {
                continue;
              }
              const candidate = new NativeSidePanel(cdp, connection.sessionId, target.targetId);
              // Chrome can report windowId=-1 in getContexts; ask the actual native view.
              const owner = await candidate
                .evaluate<number>("chrome.windows.getCurrent().then(win => win.id)")
                .catch((): undefined => undefined);
              if (owner === windowId) {
                panel = candidate;
                return true;
              }
              await cdp.send("Target.detachFromTarget", connection).catch(() => {});
            }
            return false;
          },
          { message: `Find the native panel belonging to window ${windowId}` },
        )
        .toBe(true);
    } catch (error) {
      await cdp.detach().catch(() => {});
      throw error;
    }
    return panel!;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cdp.off("Target.receivedMessageFromTarget", handler);
        reject(new Error("Native panel evaluation timed out."));
      }, 15_000);
      const handler = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== this.sessionId) {
          return;
        }
        const message = JSON.parse(event.message);
        if (message.id !== id) {
          return;
        }
        clearTimeout(timer);
        this.cdp.off("Target.receivedMessageFromTarget", handler);
        if (message.error || message.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        } else {
          resolve(message.result.result.value as T);
        }
      };
      this.cdp.on("Target.receivedMessageFromTarget", handler);
      void this.cdp
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          this.cdp.off("Target.receivedMessageFromTarget", handler);
          reject(error);
        });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    try {
      await this.cdp.detach();
    } catch (error) {
      // Replacing a native panel can also close its CDP session before cleanup runs.
      if (
        !(error instanceof Error) ||
        !/Target page, context or browser has been closed|Session closed/i.test(error.message)
      ) {
        throw error;
      }
    }
  }
}
