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
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"], windowIds: [id] }))
            .length,
        owner,
      ),
    )
    .toBeGreaterThan(0);
  return owner;
}

/** CDP is needed because a native panel may not appear in Playwright context.pages(). */
export class NativeSidePanel {
  private sequence = 0;
  private constructor(
    private cdp: CDPSession,
    private sessionId: string,
  ) {}

  static async attach(
    context: BrowserContext,
    page: Page,
    windowId: number,
  ): Promise<NativeSidePanel> {
    const cdp = await context.newCDPSession(page);
    let targets: Array<{ targetId: string; url: string }> = [];
    await expect
      .poll(async () => {
        const { targetInfos } = await cdp.send("Target.getTargets");
        targets = targetInfos.filter(
          (target) =>
            target.url.startsWith("chrome-extension://") &&
            target.url.includes("uilocation=sidepanel"),
        );
        return targets.length;
      })
      .toBeGreaterThan(0);
    for (const target of targets) {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      });
      const panel = new NativeSidePanel(cdp, sessionId);
      const owner = await panel.evaluate<number>("chrome.windows.getCurrent().then(win => win.id)");
      if (owner === windowId) {
        return panel;
      }
      await cdp.send("Target.detachFromTarget", { sessionId });
    }
    await cdp.detach();
    throw new Error(`No native panel belongs to browser window ${windowId}.`);
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
    await this.cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    await this.cdp.detach();
  }
}
