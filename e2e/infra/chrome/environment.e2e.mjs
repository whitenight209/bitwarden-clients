import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import puppeteer from "puppeteer-core";

import {
  discoverExtensionId,
  freshWorkerSession,
  prepareDevelopmentProfile,
  publicObservation,
} from "./auth-browser-helpers.mjs";

const execute = promisify(execFile);
const exec = (file, args) => execute(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
const report = {
  schemaVersion: 1,
  suite: "chrome-environment",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  steps: [],
  scope: {
    tested:
      "Headed Chrome, OS keyboard delivery, native SIDE_PANEL rendering and logged-out email input.",
    notTested:
      "Authenticated vault, master-password unlock autofocus, request brokering, multi-window routing, or extension file updates.",
    setup:
      "Onboarding and production own-UI setMode RPC prepare the environment; the settings toggle UI is not tested.",
  },
};
let browser;
let interrupted;
process.on("unhandledRejection", (error) => {
  report.unhandled = String(error);
  console.error("Unhandled browser rejection:", error);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    interrupted = new Error(`Interrupted by ${signal}`);
    void browser?.close().catch(() => {});
  });
}

async function poll(action, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    if (interrupted) throw interrupted;
    value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out; last result: ${JSON.stringify(publicObservation(value))}`);
}

async function screenshot(name) {
  await rm(`/artifacts/${name}.png`, { force: true });
  await exec("scrot", [`/artifacts/${name}.png`]);
}

function record(step) {
  report.steps.push(step);
  console.log(JSON.stringify({ step }));
}

async function bootstrapExtension() {
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
  if (existing.length) {
    throw new Error(
      "The existing extension has no manifest. Explicit recovery or reset is required.",
    );
  }
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

async function reachLoginPage(page) {
  await poll(
    async () => {
      const email = await page.$("[data-testid=login-email-input]");
      if (email && (await email.isVisible())) return true;
      const skip = await page.$("#default-password-manager-prompt_button_skip-for-now");
      if (skip && (await skip.isVisible())) {
        await skip.click();
        return false;
      }
      for (const button of await page.$$("app-intro-carousel button")) {
        if (
          (await button.evaluate((node) => node.textContent.trim())) === "Log in" &&
          (await button.isVisible())
        ) {
          await button.click();
          break;
        }
      }
      return false;
    },
    (value) => value === true,
    "Initial extension onboarding",
  );
}

try {
  await mkdir("/state", { recursive: true });
  await mkdir("/artifacts", { recursive: true });
  const reused = await bootstrapExtension();
  report.chromeDeveloperMode = await prepareDevelopmentProfile();
  const manifest = JSON.parse(await readFile("/state/extension/manifest.json", "utf8"));
  report.extension = { version: manifest.version, reused };
  browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/chrome-for-testing",
    headless: false,
    dumpio: true,
    pipe: true,
    // Startup flags preserve normal extension runtime.reload behavior.
    enableExtensions: true,
    userDataDir: "/state/profile",
    defaultViewport: null,
    protocolTimeout: 30_000,
    timeout: 30_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1500,950",
      "--no-first-run",
      "--no-default-browser-check",
      "--load-extension=/state/extension",
      "--disable-extensions-except=/state/extension",
    ],
  });
  report.browser = await browser.version();
  record({ name: "headed-chrome-on-xvfb", success: true, browser: report.browser });
  if (process.env.E2E_FORCE_FAILURE === "1") {
    throw new Error("Forced failure after headed Chrome startup (E2E_FORCE_FAILURE=1).");
  }
  const extensionId = await discoverExtensionId(browser);
  report.extension.id = extensionId;
  if (!reused) {
    const welcome = await browser.waitForTarget(
      (target) => target.url().startsWith("https://bitwarden.com/browser-start"),
      { timeout: 60_000 },
    );
    await (await welcome.asPage()).close();
  }
  const page = await browser.newPage();
  await page.goto(
    "data:text/html," +
      encodeURIComponent(
        '<!doctype html><title>Bitwarden E2E keyboard smoke</title><h1>OS keyboard environment probe</h1><label>Probe input <input id="native-keys" autofocus></label><script>window.observedKeys=[];document.addEventListener("keydown",event=>window.observedKeys.push({key:event.key,trusted:event.isTrusted}));</script>',
      ),
  );
  // Select the generic probe tab/window during setup. Nothing repairs focus after native panel opening.
  await page.bringToFront();
  const windows = await poll(
    async () => {
      try {
        const { stdout } = await exec("xdotool", [
          "search",
          "--onlyvisible",
          "--name",
          "^Bitwarden E2E keyboard smoke",
        ]);
        return stdout.trim().split(/\s+/);
      } catch {
        return [];
      }
    },
    (value) => value.length === 1,
    "Visible Chrome window title",
  );
  await exec("xdotool", ["windowactivate", "--sync", windows[0]]);
  await poll(
    () =>
      page.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.id })),
    (value) => value.focused && value.active === "native-keys",
    "Browser autofocus",
  );
  const text = "BitwardenNativeKeys123";
  // No --window: XTest sends to the actual active X11 window, not a selected CDP target.
  await exec("xdotool", ["type", "--clearmodifiers", "--delay", "25", text]);
  const typed = await poll(
    () =>
      page.evaluate(() => ({
        value: document.querySelector("#native-keys").value,
        focused: document.hasFocus(),
        active: document.activeElement?.id,
        events: window.observedKeys,
      })),
    (value) => value.value === text,
    "OS keyboard input",
  );
  assert.equal(typed.focused, true);
  assert.equal(typed.active, "native-keys");
  assert.ok(typed.events.length > 0 && typed.events.every((event) => event.trusted));
  record({
    name: "os-keyboard-input",
    success: true,
    value: typed.value,
    documentHasFocus: typed.focused,
    activeElement: typed.active,
    trustedKeyEvents: typed.events.length,
  });
  await screenshot("os-keyboard");

  const worker = await freshWorkerSession(browser, extensionId);
  const setup = await browser.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await reachLoginPage(setup);
  const mode = await setup.evaluate(() =>
    chrome.runtime.sendMessage({ customSidePanel: "setMode", enabled: true }),
  );
  assert.equal(mode?.ok, true, "Production side panel mode RPC failed");
  record({
    name: "side-panel-mode-bootstrap",
    success: true,
    method: "production own-UI setMode RPC",
  });
  await setup.close();
  await page.bringToFront();
  await poll(
    () =>
      worker.evaluate(async () => ({
        panel: await chrome.sidePanel.getOptions({}),
        popup: await chrome.action.getPopup({}),
      })),
    (value) => value.panel.enabled === true && value.popup === "",
    "Side panel mode configuration",
  );
  const extension = (await browser.extensions()).get(extensionId);
  assert.ok(extension, "Loaded extension is not listed by Chrome");
  await page.triggerExtensionAction(extension);
  const contexts = await poll(
    () => worker.evaluate(async () => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })),
    (value) =>
      value.some((context) =>
        context.documentUrl?.includes("popup/index.html?uilocation=sidepanel"),
      ),
    "Native SIDE_PANEL context",
  );
  const panelTarget = await browser.waitForTarget(
    (target) =>
      target
        .url()
        .startsWith(`chrome-extension://${extensionId}/popup/index.html?uilocation=sidepanel`),
    { timeout: 60_000 },
  );
  const panelSession = await panelTarget.createCDPSession();
  const observed = await poll(
    async () => {
      try {
        const result = await panelSession.send("Runtime.evaluate", {
          expression:
            'JSON.stringify((()=>{const email=document.querySelector("[data-testid=login-email-input]");const rect=email?.getBoundingClientRect();return {url:location.origin+location.pathname,ready:!!email&&rect.width>0&&rect.height>0&&!email.disabled,hasFocus:document.hasFocus(),activeElement:document.activeElement?.tagName,activeElementTestId:document.activeElement?.getAttribute("data-testid"),inputType:document.activeElement?.getAttribute("type"),visibleLoginEmail:!!email&&rect.width>0&&rect.height>0}})())',
          returnByValue: true,
        });
        return JSON.parse(result.result.value);
      } catch (error) {
        if (
          /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i.test(
            error.message,
          )
        ) {
          report.nativeNavigationRetries = (report.nativeNavigationRetries ?? 0) + 1;
          return { ready: false, contextNavigating: true };
        }
        throw error;
      }
    },
    (value) => value.ready,
    "Native side panel login DOM",
  );
  record({
    name: "native-side-panel-context-and-dom",
    success: true,
    contexts: contexts.map((context) => ({
      contextType: context.contextType,
      documentId: context.documentId,
      documentUrl: context.documentUrl?.split(/[?#]/)[0],
      windowId: context.windowId,
    })),
    observed,
  });
  const panelWindow = await panelSession.send("Runtime.evaluate", {
    expression:
      'Promise.allSettled([chrome.windows.getCurrent(),chrome.windows.getLastFocused()]).then(results=>results.map(result=>result.status==="fulfilled"?{id:result.value.id,type:result.value.type,focused:result.value.focused}:{error:String(result.reason)}))',
    returnByValue: true,
    awaitPromise: true,
  });
  report.diagnostics = {
    panelCurrentAndLastFocusedWindows: panelWindow.result.value,
    workerWindows: await worker.evaluate(async () =>
      (await chrome.windows.getAll()).map((window) => ({
        id: window.id,
        type: window.type,
        focused: window.focused,
      })),
    ),
    note: "SIDE_PANEL context windowId may be -1. Product request brokering and multi-window routing are not tested by this environment suite.",
  };
  if (observed.hasFocus && observed.activeElementTestId === "login-email-input") {
    await panelSession.send("Runtime.evaluate", {
      expression:
        'globalThis.__bitwardenE2EKeys=[];document.addEventListener("keydown",event=>globalThis.__bitwardenE2EKeys.push({trusted:event.isTrusted}));',
    });
    const nativeText = "poc-sidepanel@example.invalid";
    await exec("xdotool", ["type", "--clearmodifiers", "--delay", "25", nativeText]);
    const nativeResult = await panelSession.send("Runtime.evaluate", {
      expression:
        '({value:document.querySelector("[data-testid=login-email-input]").value,events:globalThis.__bitwardenE2EKeys,focused:document.hasFocus(),activeElement:document.activeElement?.getAttribute("data-testid")})',
      returnByValue: true,
    });
    const native = nativeResult.result.value;
    assert.equal(native.value, nativeText);
    assert.equal(native.focused, true);
    assert.equal(native.activeElement, "login-email-input");
    assert.ok(native.events.length > 0 && native.events.every((event) => event.trusted));
    record({
      name: "native-side-panel-os-keys",
      success: true,
      input: native.activeElement,
      value: native.value,
      trustedKeyEvents: native.events.length,
      noFocusRepair: true,
    });
  } else {
    throw new Error(
      "Native login email input did not receive automatic focus; no focus repair was applied.",
    );
  }
  await screenshot("native-side-panel");
  await panelSession.detach();
  assert.equal(report.unhandled, undefined, "Unexpected unhandled browser rejection");
  if (interrupted) throw interrupted;
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = { name: error.name, message: error.message, stack: error.stack };
  await screenshot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
      report.browserClosed = true;
    } catch (error) {
      report.browserClosed = false;
      report.closeError = String(error);
      report.success = false;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir("/artifacts", { recursive: true });
  await writeFile("/artifacts/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
