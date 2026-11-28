import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const exec = (program, args) =>
  execute(program, args, { timeout: 10_000, maxBuffer: 1024 * 1024 });

export function publicObservation(value) {
  if (typeof value === "string") {
    if (value.startsWith("chrome-extension://") || value.startsWith("popup/index.html?"))
      return value.split(/[?#]/)[0];
    return value;
  }
  if (Array.isArray(value)) return value.map(publicObservation);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, publicObservation(entry)]),
    );
  return value;
}

function evaluationDiagnostic(value) {
  let text = String(value ?? "").split("\n")[0];
  const password = process.env.E2E_PASSWORD;
  if (password) text = text.split(password).join("[REDACTED]");
  return text
    .replace(/access_token=[^\s'"&]+/g, "access_token=[REDACTED]")
    .replace(/sidePanelDocument=[^\s'"&#]+/g, "sidePanelDocument=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .slice(0, 400);
}

export async function poll(action, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${label} timed out; last public observation: ${JSON.stringify(publicObservation(last))}`,
  );
}

export async function screenshot(name) {
  await rm(`/artifacts/${name}.png`, { force: true });
  await exec("scrot", [`/artifacts/${name}.png`]);
}

export async function bootstrapExtension() {
  await mkdir("/state", { recursive: true });
  try {
    await readFile("/state/extension/manifest.json");
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = await readdir("/state/extension").catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length)
    throw new Error("Existing extension needs explicit recovery; bootstrap will not overwrite it.");
  const temporary = await mkdtemp("/state/.extension-bootstrap-");
  try {
    await cp("/extension-source", temporary, { recursive: true });
    JSON.parse(await readFile(`${temporary}/manifest.json`, "utf8"));
    await rename(temporary, "/state/extension");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return false;
}

/** Only the disposable test profile; preserve unrelated preferences across restarts. */
export async function prepareDevelopmentProfile() {
  const directory = "/state/profile/Default";
  const file = `${directory}/Preferences`;
  await mkdir(directory, { recursive: true });
  let preferences;
  try {
    preferences = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    preferences = {};
  }
  preferences.extensions ??= {};
  preferences.extensions.ui ??= {};
  preferences.extensions.ui.developer_mode = true;
  await writeFile(`${file}.e2e-tmp`, JSON.stringify(preferences));
  await rename(`${file}.e2e-tmp`, file);
  const actual = JSON.parse(await readFile(file, "utf8"));
  return actual.extensions?.ui?.developer_mode === true;
}

export async function visible(page, selector) {
  const element = await page.$(selector);
  return element && (await element.isVisible()) ? element : undefined;
}

export async function waitVisible(page, selector, label = selector) {
  await poll(async () => !!(await visible(page, selector)), Boolean, label);
  return page.$(selector);
}

export async function clickText(page, selector, pattern) {
  for (const element of await page.$$(selector)) {
    const text = await element.evaluate((node) => node.textContent.trim());
    if (pattern.test(text) && (await element.isVisible())) {
      await element.click();
      return true;
    }
  }
  return false;
}

/** Setup only: wait for route animations before a real pointer click. Never repair panel focus. */
export async function clickStableSetup(page, selector) {
  const element = await waitVisible(page, selector);
  let previous;
  const box = await poll(
    () =>
      element.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          width: rect.width,
          height: rect.height,
          connected: node.isConnected,
          disabled: !!node.disabled,
          hit: hit === node || node.contains(hit),
        };
      }),
    (current) => {
      const stable =
        previous &&
        ["x", "y", "width", "height"].every((key) => Math.abs(previous[key] - current[key]) < 0.5);
      previous = current;
      return (
        stable &&
        current.connected &&
        !current.disabled &&
        current.width > 0 &&
        current.height > 0 &&
        current.hit
      );
    },
    `${selector} stable setup pointer target`,
  );
  await page.mouse.click(box.x, box.y);
  return box;
}

export async function reachLoginPage(page) {
  await poll(
    async () => {
      if (await visible(page, "[data-testid=login-email-input]")) return true;
      const skip = await visible(page, "#default-password-manager-prompt_button_skip-for-now");
      if (skip) {
        await skip.click();
        return false;
      }
      await clickText(page, "app-intro-carousel button", /^Log in$/);
      return false;
    },
    Boolean,
    "Extension login page after onboarding",
  );
}

export async function dismissOnboarding(page) {
  for (const [heading, label] of [
    ["You're in! Welcome to Bitwarden", "Skip"],
    ["Get the extension for easy vault access", "Skip"],
    ["Bitwarden has a new look", "Close"],
    ["Invite your whole team with a single link", "Skip"],
  ]) {
    for (const dialog of await page.$$("[role=dialog]")) {
      if ((await dialog.evaluate((node) => node.textContent)).includes(heading)) {
        for (const button of await dialog.$$("button")) {
          if ((await button.evaluate((node) => node.textContent.trim())) === label)
            await button.click();
        }
      }
    }
  }
}

export async function check(page, selector) {
  const input = await waitVisible(page, selector);
  if (!(await input.evaluate((node) => node.checked))) {
    for (const close of await page.$$('[data-testid="bit-toast-close"]')) {
      if (await close.isVisible()) await close.click();
    }
    await input.scrollIntoView();
    await poll(
      () =>
        input.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === node || node.contains(hit);
        }),
      Boolean,
      `${selector} is not covered by another UI element`,
    );
    await input.click();
  }
  await poll(() => page.$eval(selector, (node) => node.checked), Boolean, `${selector} checked`);
}

/** The secret is stdin only; it never becomes an OS process argument or shell source. */
export async function typeSecretWithOsKeys(secret) {
  await new Promise((resolve, reject) => {
    const child = spawn("xdotool", ["type", "--clearmodifiers", "--delay", "20", "--file", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OS keyboard typing timed out"));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`OS keyboard typing failed (exit ${code}): ${stderr}`));
    });
    child.stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(secret);
  });
}

export async function workerFor(browser, extensionId) {
  return freshWorkerSession(browser, extensionId);
}

/** Read the real startup-loaded extension ID without the Extensions.loadUnpacked API. */
export async function discoverExtensionId(browser) {
  const session = await browser.target().createCDPSession();
  try {
    const target = await poll(
      async () => {
        const { targetInfos } = await session.send("Target.getTargets");
        return targetInfos.find(
          (item) =>
            item.type === "service_worker" &&
            /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(item.url),
        );
      },
      Boolean,
      "Startup-loaded extension service worker",
      60_000,
    );
    return new URL(target.url).hostname;
  } finally {
    await session.detach();
  }
}

export function unlockButton(node) {
  const attributes = node.attributes ?? [];
  if (
    node.nodeName === "BUTTON" &&
    attributes.some((value) =>
      value
        .split(/\s+/)
        .some((token) => ["unlock-button", "inline-menu-unlock-button"].includes(token)),
    )
  )
    return node;
  const descendants = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) descendants.push(node.contentDocument);
  for (const child of descendants) {
    const found = unlockButton(child);
    if (found) return found;
  }
}

class NestedSession {
  sequence = 0;
  constructor(owner, sessionId) {
    this.owner = owner;
    this.sessionId = sessionId;
  }
  async send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.owner.off("Target.receivedMessageFromTarget", receive);
      };
      const receive = (event) => {
        if (event.sessionId !== this.sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        cleanup();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Inline frame ${method} timed out`));
      }, 15_000);
      this.owner.on("Target.receivedMessageFromTarget", receive);
      void this.owner
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }
  async detach() {
    await this.owner.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    await this.owner.detach();
  }
}

/** Avoid Puppeteer's workerScriptLoaded deferred when attaching after an extension reload. */
export async function liveWorkerTargets(browser, extensionId) {
  const session = await browser.target().createCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    return targetInfos
      .filter(
        (target) =>
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js`,
      )
      .map((target) => ({ targetId: target.targetId, type: target.type }));
  } finally {
    await session.detach();
  }
}

export async function freshWorkerSession(
  browser,
  extensionId,
  { wait = true, timeout = 15_000, excludeTargetIds = [] } = {},
) {
  const owner = await browser.target().createCDPSession();
  let session;
  try {
    const find = async () => {
      const { targetInfos } = await owner.send("Target.getTargets");
      return targetInfos.find(
        (target) =>
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js` &&
          !excludeTargetIds.includes(target.targetId),
      );
    };
    const target = wait
      ? await poll(find, Boolean, "Fresh extension worker CDP target", timeout)
      : await find();
    if (!target) throw new Error("No live extension worker CDP target");
    const { sessionId } = await owner.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    session = new NestedSession(owner, sessionId);
    await session.send("Runtime.runIfWaitingForDebugger");
    await session.send("Runtime.enable");
    return {
      targetId: target.targetId,
      async evaluate(operation, ...args) {
        const response = await session.send("Runtime.evaluate", {
          expression: `(${operation.toString()})(...${JSON.stringify(args)})`,
          returnByValue: true,
          awaitPromise: true,
        });
        if (response.exceptionDetails) {
          const details = response.exceptionDetails;
          const publicDetails = {
            text: evaluationDiagnostic(details.text),
            exceptionType: evaluationDiagnostic(details.exception?.className),
            message: evaluationDiagnostic(details.exception?.description),
            line: details.lineNumber,
            column: details.columnNumber,
          };
          const error = new Error(`Worker CDP evaluation failed: ${JSON.stringify(publicDetails)}`);
          error.name = "WorkerEvaluationError";
          throw error;
        }
        return response.result.value;
      },
      detach: () => session.detach(),
    };
  } catch (error) {
    if (session) await session.detach().catch(() => {});
    else await owner.detach().catch(() => {});
    throw error;
  }
}

/** Click the extension's real closed-shadow inline Unlock control, never an injected test opener. */
export async function clickInlineUnlock(browser, website, extensionId) {
  const log = (stage, details = {}) =>
    console.log(JSON.stringify({ inlineStage: stage, ...details }));
  await poll(
    () => website.frames().some((frame) => frame.url().includes("/overlay/menu-list.html")),
    Boolean,
    "Real inline menu iframe",
  );
  const frame = website.frames().find((frame) => frame.url().includes("/overlay/menu-list.html"));
  const frameUrl = frame.url();
  log("real-iframe-observed", {
    dynamicFrameOrigin: !frameUrl.startsWith(`chrome-extension://${extensionId}/`),
    frameId: frame._id,
  });
  const owner = await browser.target().createCDPSession();
  let documentHandle;
  let frameElement;
  try {
    const { targetInfos } = await owner.send("Target.getTargets");
    log("fresh-frame-target-observation", {
      targets: targetInfos
        .filter((target) => target.type === "iframe" || target.type === "other")
        .map((target) => ({
          targetId: target.targetId,
          type: target.type,
          url: target.url.split(/[?#]/)[0],
          title: target.title.slice(0, 120),
        })),
    });
    // CdpFrame.client is the exact pinned Puppeteer frame session. A document
    // object handle identifies this frame even if it shares the parent target.
    const session = frame.client;
    if (!session?.send) throw new Error("Pinned Puppeteer frame CDP client is unavailable");
    documentHandle = await frame.evaluateHandle(() => document);
    const objectId = documentHandle.remoteObject().objectId;
    if (!objectId) throw new Error("The real inline frame has no document object handle");
    log("exact-frame-document-bound");
    await session.send("DOM.enable");
    let domObserved = false;
    const button = await poll(
      async () => {
        const { node: root } = await session.send("DOM.describeNode", {
          objectId,
          depth: -1,
          pierce: true,
        });
        const node = unlockButton(root);
        if (!domObserved) {
          log("pierced-dom-observed", { unlockButtonPresent: !!node });
          domObserved = true;
        }
        if (!node) return undefined;
        try {
          await session.send("DOM.getBoxModel", {
            backendNodeId: node.backendNodeId,
          });
          return node;
        } catch {
          return undefined;
        }
      },
      Boolean,
      "Visible real inline Unlock button",
    );
    const { object: control } = await session.send("DOM.resolveNode", {
      backendNodeId: button.backendNodeId,
    });
    const { result: point } = await session.send("Runtime.callFunctionOn", {
      objectId: control.objectId,
      functionDeclaration: `function () {
        this.addEventListener("click", (event) => {
          this.__inlineUnlockTrustedClick = event.isTrusted;
        }, { once: true });
        const rect = this.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }`,
      returnByValue: true,
    });
    // Pointer coordinates belong to the website's viewport. Dispatching local coordinates
    // on an OOPIF session can miss after Chrome resizes the website for the side panel.
    frameElement = await frame.frameElement();
    const frameBox = await frameElement?.boundingBox();
    if (!frameBox) throw new Error("Visible inline menu iframe has no website bounds");
    const border = await frameElement.evaluate((element) => ({
      x: element.clientLeft,
      y: element.clientTop,
    }));
    const x = frameBox.x + border.x + point.value.x;
    const y = frameBox.y + border.y + point.value.y;
    log("real-unlock-button-pointer-target", { x, y });
    await website.mouse.click(x, y);
    log("real-unlock-button-pointer-dispatched");
    const observed = await session
      .send("Runtime.callFunctionOn", {
        objectId: control.objectId,
        functionDeclaration: "function () { return this.__inlineUnlockTrustedClick ?? null; }",
        returnByValue: true,
      })
      .then(({ result }) => result.value)
      .catch(() => "frame-disconnected");
    log("real-unlock-button-pointer-observed", { trustedClick: observed });
    return {
      actualControl: true,
      closedShadowPierced: true,
      dynamicFrameOrigin: !frameUrl.startsWith(`chrome-extension://${extensionId}/`),
    };
  } finally {
    await frameElement?.dispose().catch(() => {});
    await documentHandle?.dispose().catch(() => {});
    await owner.detach().catch(() => {});
  }
}
