import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import puppeteer from "puppeteer-core";

import {
  bootstrapExtension,
  check,
  clickInlineUnlock,
  clickStableSetup,
  clickText,
  dismissOnboarding,
  discoverExtensionId,
  exec,
  freshWorkerSession,
  liveWorkerTargets,
  poll,
  prepareDevelopmentProfile,
  reachLoginPage,
  screenshot,
  typeSecretWithOsKeys,
  visible,
  waitVisible,
} from "./auth-browser-helpers.mjs";
import { registerTemporaryAccount, waitForTestServer } from "./test-server.mjs";

const password = process.env.E2E_PASSWORD;
const preopenLockedPanel = process.env.E2E_PREOPEN_LOCKED_PANEL === "1";
const account = {
  server: process.env.E2E_SERVER,
  email: process.env.E2E_EMAIL,
  password,
  name: "Temporary Chrome E2E account",
};
const redact = (value) => {
  let text = String(value);
  if (password) text = text.split(password).join("[REDACTED]");
  return text
    .replace(/access_token=[^\s'"&]+/g, "access_token=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
};
const report = {
  schemaVersion: 1,
  suite: "authenticated-inline-unlock",
  variant: preopenLockedPanel ? "preopened-locked-panel" : "closed-panel",
  unlockPanelBehavior:
    "Explicit unlock refreshes the locked panel document and discards partial password input.",
  startedAt: new Date().toISOString(),
  steps: [],
  scope:
    "Temporary VM-local Vaultwarden account; real extension login, settings toggle, account lock, original inline Unlock control, native password autofocus and OS keyboard unlock. Existing personal profiles are never used.",
};
let browser;
let native;
let nativeTarget;
let expectedOwnerWindowId;
let expectedBrowserWindows;
let extensionPopup;
let fixturePage;
let background;
const popupErrors = [];
const popupRequests = [];
let secretInputActive = false;
let phase = "validate-test-environment";
process.on("unhandledRejection", (error) => {
  report.unhandled = redact(error);
  console.error(redact(error));
});
function setPhase(next) {
  phase = next;
  console.log(JSON.stringify({ phase }));
}
function record(name, details = {}) {
  report.steps.push({ name, success: true, ...details });
  console.log(redact(JSON.stringify({ step: name, success: true, ...details })));
}
async function bounded(operation, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const diagnosticLog = (stage, details = {}) =>
  console.log(redact(JSON.stringify({ diagnosticStage: stage, ...details })));
async function nativeState() {
  if (!native) return undefined;
  let result;
  try {
    result = await native.send("Runtime.evaluate", {
      expression:
        '({route:location.hash.split("?")[0],queryKeys:[...new URLSearchParams(location.search).keys()],singleActionPopout:new URLSearchParams(location.search).get("singleActionPopout")==="auth_unlockExtension"?"auth_unlockExtension":null,userActivation:{isActive:navigator.userActivation?.isActive,hasBeenActive:navigator.userActivation?.hasBeenActive},hasFocus:document.hasFocus(),activeElement:document.activeElement?.getAttribute("data-testid"),inputType:document.activeElement?.getAttribute("type"),masterPasswordVisible:(()=>{const input=document.querySelector("[data-testid=lock-master-password-input]");const r=input?.getBoundingClientRect();return !!input&&r.width>0&&r.height>0&&!input.disabled})(),lockScreen:!!document.querySelector("[data-testid=lock-screen]"),accountButton:!!document.querySelector("[data-testid=current-account-button]")})',
      returnByValue: true,
    });
  } catch (error) {
    if (
      /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i.test(
        error.message,
      )
    ) {
      report.nativeNavigationRetries = (report.nativeNavigationRetries ?? 0) + 1;
      return undefined;
    }
    throw error;
  }
  return result.result.value;
}
async function panelContexts(extensionId) {
  return background.evaluate(
    async (id) =>
      (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).filter((context) => {
        const url = context.documentUrl && new URL(context.documentUrl);
        return (
          url?.host === id &&
          url.pathname === "/popup/index.html" &&
          url.searchParams.get("uilocation") === "sidepanel"
        );
      }),
    extensionId,
  );
}
async function attachRequestedPanel(extensionId, previousDocumentId) {
  await poll(
    () => panelContexts(extensionId),
    (contexts) =>
      contexts.length === 1 &&
      !!contexts[0].documentId &&
      (!previousDocumentId || contexts[0].documentId !== previousDocumentId),
    previousDocumentId
      ? "Previous panel document closed and one replacement exists"
      : "One native panel exists",
  );
  const previousTarget = nativeTarget;
  await native?.detach().catch(() => {});
  nativeTarget = await browser.waitForTarget(
    (target) =>
      target !== previousTarget &&
      target
        .url()
        .startsWith(`chrome-extension://${extensionId}/popup/index.html?uilocation=sidepanel`),
    { timeout: 60_000 },
  );
  native = await nativeTarget.createCDPSession();
}
async function assertRequestedPanel(extensionId, previousDocumentId) {
  const contexts = await panelContexts(extensionId);
  assert.equal(contexts.length, 1, "Exactly one native panel must remain active");
  const context = contexts[0];
  assert.ok(context.documentId, "Native panel context has no observable document identity");
  if (previousDocumentId)
    assert.notEqual(
      context.documentId,
      previousDocumentId,
      "Explicit unlock did not refresh the old lock document",
    );
  const owner = await native.send("Runtime.evaluate", {
    expression:
      'chrome.windows.getCurrent().then(window=>({id:window.id,type:window.type,inputEmpty:document.querySelector("[data-testid=lock-master-password-input]")?.value===""}))',
    returnByValue: true,
    awaitPromise: true,
  });
  assert.equal(
    owner.result.value?.id,
    expectedOwnerWindowId,
    "Native panel belongs to another browser window",
  );
  assert.equal(owner.result.value?.type, "normal", "Unlock opened a separate popup window");
  assert.ok(
    owner.result.value?.inputEmpty,
    "A fresh explicit unlock must begin with an empty password input",
  );
  const windows = await background.evaluate(async () =>
    (await chrome.windows.getAll())
      .map(({ id, type }) => ({ id, type }))
      .sort((a, b) => a.id - b.id),
  );
  assert.deepEqual(
    windows,
    expectedBrowserWindows,
    "Unlock created an extra Chrome window or popup",
  );
  report.nativeContexts = contexts.map((item) => ({
    contextType: item.contextType,
    documentId: item.documentId,
    documentUrl: item.documentUrl?.split(/[?#]/)[0],
    sidePanelUi: true,
    windowId: item.windowId,
  }));
  return {
    documentId: context.documentId,
    previousDocumentId,
    documentRefreshed: !!previousDocumentId,
    activeNativePanels: 1,
    sameOwnerWindow: true,
    noAdditionalChromeWindow: true,
    passwordInputEmpty: true,
  };
}
async function diagnose(extensionId) {
  const result = { phase };
  try {
    diagnosticLog("fresh-cdp-targets-start");
    const session = await browser.target().createCDPSession();
    try {
      const { targetInfos } = await session.send("Target.getTargets");
      result.targets = targetInfos
        .filter((target) => target.url.startsWith("chrome-extension://"))
        .map((target) => ({
          targetId: target.targetId,
          type: target.type,
          url: target.url.split(/[?#]/)[0],
          attached: target.attached,
        }));
      diagnosticLog("fresh-cdp-targets-complete", { targets: result.targets });
    } finally {
      await session.detach();
    }
  } catch (error) {
    result.targetError = redact(error);
  }
  if (extensionPopup && !extensionPopup.isClosed()) {
    try {
      diagnosticLog("popup-start");
      result.popup = await extensionPopup.evaluate(() => {
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return {
          route: location.hash.split("?")[0],
          pathname: location.pathname,
          readyState: document.readyState,
          headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")]
            .filter(visible)
            .map((node) => node.textContent.trim().slice(0, 160)),
          buttons: [...document.querySelectorAll("button,[role=menuitem]")]
            .filter(visible)
            .map((node) => ({
              text: node.textContent.trim().slice(0, 160),
              testId: node.getAttribute("data-testid"),
              disabled: !!node.disabled,
              ariaDisabled: node.getAttribute("aria-disabled"),
            })),
          inputs: [...document.querySelectorAll("input")].filter(visible).map((node) => ({
            id: node.id,
            type: node.type,
            testId: node.getAttribute("data-testid"),
            disabled: node.disabled,
            valid: node.validity.valid,
          })),
          alerts: [...document.querySelectorAll('[role="alert"]')]
            .filter(visible)
            .map((node) => node.textContent.trim().slice(0, 240)),
        };
      });
      diagnosticLog("popup-complete", { observation: result.popup });
    } catch (error) {
      result.popupError = redact(error);
    }
  }
  result.popupErrors = popupErrors;
  result.popupRequests = popupRequests;
  if (fixturePage && !fixturePage.isClosed()) {
    try {
      diagnosticLog("website-start");
      result.website = await fixturePage.evaluate(() => ({
        origin: location.origin,
        pathname: location.pathname,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        activeInput: {
          tag: document.activeElement?.tagName,
          type: document.activeElement?.getAttribute("type"),
          name: document.activeElement?.getAttribute("name"),
        },
        inputCount: document.querySelectorAll("input").length,
        iframeCount: document.querySelectorAll("iframe").length,
      }));
      result.website.frames = fixturePage.frames().map((frame) => frame.url().split(/[?#]/)[0]);
      diagnosticLog("website-snapshot", { observation: result.website });
      const session = await fixturePage.target().createCDPSession();
      try {
        const executionContexts = [];
        session.on("Runtime.executionContextCreated", ({ context }) => {
          executionContexts.push({
            id: context.id,
            origin: context.origin,
            name: context.name,
            isDefault: context.auxData?.isDefault,
            type: context.auxData?.type,
          });
        });
        diagnosticLog("website-runtime-start");
        await session.send("Runtime.enable");
        result.website.executionContexts = executionContexts;
        diagnosticLog("website-runtime-contexts", { executionContexts });
        for (const context of executionContexts.filter((context) => !context.isDefault)) {
          const observation = await session.send("Runtime.evaluate", {
            contextId: context.id,
            expression:
              '({initType:typeof window.bitwardenAutofillInit,isMonitoring:typeof window.bitwardenAutofillInit?.isMonitoring==="boolean"?window.bitwardenAutofillInit.isMonitoring:null})',
            returnByValue: true,
          });
          context.autofill = observation.result.value;
          diagnosticLog("website-isolated-autofill-state", { context });
        }
        diagnosticLog("website-dom-start");
        await session.send("DOM.enable");
        const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
        const hosts = [];
        const visit = (node) => {
          if (node.shadowRoots?.length)
            hosts.push({
              tag: node.nodeName,
              rootTypes: node.shadowRoots.map((shadow) => shadow.shadowRootType),
            });
          for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
          if (node.contentDocument) visit(node.contentDocument);
        };
        visit(root);
        result.website.shadowHosts = hosts;
        diagnosticLog("website-dom-complete", { shadowHosts: hosts });
      } finally {
        await session.detach();
      }
    } catch (error) {
      result.websiteError = redact(error);
    }
  }
  try {
    diagnosticLog("panel-start");
    result.panel = await nativeState();
    if (native) {
      const owner = await native.send("Runtime.evaluate", {
        expression: "chrome.windows.getCurrent().then(window=>({id:window.id,type:window.type}))",
        returnByValue: true,
        awaitPromise: true,
      });
      result.panelOwner = owner.result.value;
    }
    diagnosticLog("panel-complete", { observation: result.panel, owner: result.panelOwner });
  } catch (error) {
    result.panelError = redact(error);
  }
  try {
    diagnosticLog("worker-start");
    const worker = await freshWorkerSession(browser, extensionId, { wait: false });
    try {
      result.contexts = await worker.evaluate(async () =>
        (await chrome.runtime.getContexts({})).map((context) => ({
          contextType: context.contextType,
          documentId: context.documentId,
          windowId: context.windowId,
          documentUrl: context.documentUrl?.split("#")[0].split("?")[0],
        })),
      );
      result.windows = await worker.evaluate(async () =>
        (await chrome.windows.getAll()).map((window) => ({
          id: window.id,
          type: window.type,
          focused: window.focused,
        })),
      );
      result.hostPermissions = await worker.evaluate(async () => {
        const permissions = await chrome.permissions.getAll();
        return { permissions: permissions.permissions, origins: permissions.origins };
      });
      result.savedPanelRoutes = await worker.evaluate(async () => {
        const routes = (await chrome.storage.session.get("customSidePanelRoutes"))
          .customSidePanelRoutes;
        return Object.fromEntries(
          Object.entries(routes ?? {}).map(([windowId, route]) => [
            windowId,
            typeof route === "string" ? route.split(/[?;]/)[0] : "[unavailable]",
          ]),
        );
      });
      diagnosticLog("worker-complete", {
        contexts: result.contexts,
        windows: result.windows,
        hostPermissions: result.hostPermissions,
        savedPanelRoutes: result.savedPanelRoutes,
      });
    } finally {
      await worker.detach();
    }
  } catch (error) {
    result.contextError = redact(error);
  }
  return result;
}

try {
  assert.ok(
    account.email && password && account.server,
    "E2E_EMAIL, E2E_PASSWORD and E2E_SERVER are required",
  );
  const serverUrl = new URL(account.server);
  assert.ok(
    ["http:", "https:"].includes(serverUrl.protocol) &&
      ["localhost", "127.0.0.1"].includes(serverUrl.hostname) &&
      !serverUrl.username &&
      !serverUrl.password,
    "Authenticated E2E is restricted to the temporary localhost server",
  );
  report.account = { email: account.email, server: serverUrl.origin };
  await mkdir("/artifacts", { recursive: true });
  const health = await waitForTestServer({ server: account.server });
  record("temporary-vm-test-server-ready", health);
  const reused = await bootstrapExtension();
  report.chromeDeveloperMode = await prepareDevelopmentProfile();
  const manifest = JSON.parse(await readFile("/state/extension/manifest.json", "utf8"));
  report.extension = { version: manifest.version, reused };
  const tlsSpki = process.env.E2E_TLS_SPKI;
  if (tlsSpki)
    assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(tlsSpki), "E2E_TLS_SPKI must be a SHA-256 SPKI pin");
  setPhase("launch-headed-chrome");
  browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/chrome-for-testing",
    headless: false,
    pipe: true,
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
      ...(tlsSpki ? [`--ignore-certificate-errors-spki-list=${tlsSpki}`] : []),
    ],
  });
  let stderrLine = "";
  browser.process()?.stderr?.on("data", (chunk) => {
    stderrLine += chunk.toString();
    const lines = stderrLine.split("\n");
    stderrLine = lines.pop();
    if (lines.length)
      void appendFile("/artifacts/chrome.log", redact(lines.join("\n") + "\n")).catch(() => {});
  });
  record("headed-chrome-ready", { browser: await browser.version() });
  if (process.env.E2E_FORCE_FAILURE === "1")
    throw new Error("Forced failure after headed Chrome startup");
  const extensionId = await discoverExtensionId(browser);
  report.extension.id = extensionId;
  if (!reused) {
    const welcome = await browser.waitForTarget(
      (target) => target.url().startsWith("https://bitwarden.com/browser-start"),
      { timeout: 60_000 },
    );
    await (await welcome.asPage()).close();
  }

  setPhase("create-temporary-account");
  const signup = await browser.newPage();
  secretInputActive = true;
  let registration;
  try {
    registration = await registerTemporaryAccount(signup, account);
  } finally {
    await signup.close().catch(() => {});
  }
  secretInputActive = false;
  record("temporary-account-registered", registration);

  setPhase("extension-login-page-bootstrap");
  const popup = await browser.newPage();
  extensionPopup = popup;
  popup.on("pageerror", (error) => {
    if (popupErrors.length < 20) popupErrors.push(redact(error.message));
  });
  popup.on("response", (response) => {
    const url = new URL(response.url());
    if (["http:", "https:"].includes(url.protocol) && popupRequests.length < 30)
      popupRequests.push({
        method: response.request().method(),
        origin: url.origin,
        pathname: url.pathname,
        status: response.status(),
      });
  });
  const extensionPage = `chrome-extension://${extensionId}/popup/index.html`;
  await popup.goto(extensionPage);
  setPhase("extension-onboarding-to-login-page");
  await reachLoginPage(popup);
  record("extension-login-page-ready");
  setPhase("extension-self-hosted-environment-menu");
  await (await waitVisible(popup, 'environment-selector button[aria-haspopup="menu"]')).click();
  await poll(
    () => clickText(popup, '[role="menuitem"]', /self-hosted/i),
    Boolean,
    "Self-hosted environment menu",
  );
  setPhase("extension-self-hosted-server-dialog");
  const baseUrl = await waitVisible(popup, "#self_hosted_env_settings_form_input_base_url");
  await baseUrl.click({ clickCount: 3 });
  await baseUrl.type(account.server);
  assert.ok(await clickText(popup, "button", /^Save$/), "Self-hosted server Save button missing");
  await poll(
    async () => !(await visible(popup, "#self_hosted_env_settings_form_input_base_url")),
    Boolean,
    "Self-hosted server dialog closed",
  );
  record("extension-self-hosted-environment-saved", { server: serverUrl.origin });
  setPhase("extension-login-email-submit");
  await popup.type("[data-testid=login-email-input]", account.email);
  await (await waitVisible(popup, "[data-testid=login-continue-button]")).click();
  setPhase("extension-login-master-password-screen");
  await waitVisible(popup, "[data-testid=login-master-password-input]");
  record("extension-master-password-screen-ready");
  setPhase("extension-login-master-password-submit");
  secretInputActive = true;
  await popup.type("[data-testid=login-master-password-input]", password);
  await (await waitVisible(popup, "[data-testid=login-submit-button]")).click();
  setPhase("extension-login-vault-completion");
  await poll(
    async () => {
      await dismissOnboarding(popup);
      return /^#\/tabs\//.test(new URL(popup.url()).hash);
    },
    Boolean,
    "Actual extension login completed",
    90_000,
  );
  secretInputActive = false;
  record("extension-login-completed", { route: new URL(popup.url()).hash });
  await dismissOnboarding(popup);

  setPhase("enable-inline-and-side-panel-settings");
  await popup.goto(extensionPage + "#/autofill");
  await dismissOnboarding(popup);
  await check(popup, "#show-inline-menu");
  setPhase("verify-inline-menu-setting-persisted");
  const inlineVisibility = await poll(
    () =>
      popup.evaluate(async () => {
        const key = "global_autofillSettingsLocal_inlineMenuVisibility";
        const stored = (await chrome.storage.local.get(key))[key];
        const value =
          stored?.__json__ === true && typeof stored.value === "string"
            ? JSON.parse(stored.value)
            : stored;
        return { visibility: typeof value === "number" ? value : null, storedType: typeof stored };
      }),
    (value) => value.visibility === 2,
    "Inline menu OnFieldFocus setting persisted",
    15_000,
  );
  record("inline-menu-field-focus-setting-persisted", inlineVisibility);
  setPhase("enable-side-panel-settings");
  await popup.goto(extensionPage + "#/appearance");
  await dismissOnboarding(popup);
  await check(popup, "[data-testid=side-panel-mode]");
  await poll(
    () =>
      popup.evaluate(async () => ({
        panel: await chrome.sidePanel.getOptions({}),
        popup: await chrome.action.getPopup({}),
      })),
    (value) => value.panel.enabled === true && value.popup === "",
    "Side panel mode enabled through settings UI",
  );
  record("side-panel-and-inline-enabled-through-real-settings-ui");

  setPhase("lock-account-vault-page");
  // This is setup, before the original web entrypoint. Background tabs can suspend
  // animation frames that Puppeteer's real element clicks wait for.
  await popup.bringToFront();
  await popup.goto(extensionPage + "#/tabs/vault");
  await dismissOnboarding(popup);
  setPhase("lock-account-open-account-menu");
  const avatarTarget = await clickStableSetup(popup, "[data-testid=current-account-button]");
  record("account-menu-real-pointer-click", { target: avatarTarget });
  await poll(
    () => new URL(popup.url()).hash.split("?")[0],
    (route) => route === "#/account-switcher",
    "Account switcher route after avatar pointer click",
  );
  setPhase("lock-account-select-lock-now");
  const beforeLockWorkers = await liveWorkerTargets(browser, extensionId);
  assert.ok(beforeLockWorkers.length > 0, "No extension worker exists before account lock");
  record("pre-lock-worker-targets-observed", { workers: beforeLockWorkers });
  await clickStableSetup(popup, "[data-testid=account-switcher-lock-now-button]").catch((error) => {
    if (!/Target closed|Session closed|Execution context.*destroyed/i.test(String(error)))
      throw error;
  });
  setPhase("lock-account-confirm-lock-screen");
  await poll(
    async () =>
      popup.isClosed() || !!(await visible(popup, "[data-testid=lock-screen]").catch(() => false)),
    Boolean,
    "Account lock closed or replaced the extension UI",
  );
  if (!popup.isClosed()) await popup.close();
  record("account-locked-through-real-ui");

  setPhase("wait-for-actual-lock-extension-reload");
  background = await freshWorkerSession(browser, extensionId, {
    excludeTargetIds: beforeLockWorkers.map((target) => target.targetId),
    timeout: 60_000,
  });
  await bounded(
    background.evaluate(() => true),
    "Reloaded locked extension worker responsiveness",
    5_000,
  );
  record("locked-extension-reloaded-with-new-responsive-worker", {
    targetId: background.targetId,
    rawCdp: true,
  });
  setPhase("wait-for-reloaded-worker-chrome-api-bindings");
  const workerApis = await poll(
    () =>
      background.evaluate(() => ({
        runtimeContexts:
          typeof chrome !== "undefined" && typeof chrome.runtime?.getContexts === "function",
        windowsGetAll:
          typeof chrome !== "undefined" && typeof chrome.windows?.getAll === "function",
      })),
    (value) => value.runtimeContexts && value.windowsGetAll,
    "Reloaded worker Chrome API bindings are available",
    10_000,
  );
  record("reloaded-worker-chrome-api-bindings-ready", workerApis);
  setPhase("observe-original-browser-window-layout");
  expectedBrowserWindows = await background.evaluate(async () =>
    (await chrome.windows.getAll())
      .map(({ id, type }) => ({ id, type }))
      .sort((a, b) => a.id - b.id),
  );
  const normalWindows = expectedBrowserWindows.filter((window) => window.type === "normal");
  assert.equal(
    normalWindows.length,
    1,
    "This regression fixture requires one normal browser window",
  );
  assert.equal(expectedBrowserWindows.length, 1, "Setup unexpectedly created a Chrome popup");
  expectedOwnerWindowId = normalWindows[0].id;
  let preopenedDocumentId;

  if (preopenLockedPanel) {
    setPhase("preopen-locked-panel-through-real-toolbar-action");
    const blank =
      (await browser.pages()).find((page) => page.url() === "about:blank") ??
      (await browser.newPage());
    await blank.bringToFront();
    const extension = (await browser.extensions()).get(extensionId);
    assert.ok(extension, "The startup-loaded extension is unavailable for the toolbar action");
    await blank.triggerExtensionAction(extension);
    nativeTarget = await browser.waitForTarget(
      (target) =>
        target
          .url()
          .startsWith(`chrome-extension://${extensionId}/popup/index.html?uilocation=sidepanel`),
      { timeout: 60_000 },
    );
    native = await nativeTarget.createCDPSession();
    const preopened = await poll(
      nativeState,
      (value) =>
        value?.masterPasswordVisible &&
        value.hasFocus &&
        value.singleActionPopout === null &&
        !value.queryKeys.includes("singleActionPopout"),
      "Toolbar-opened locked panel is ready before any inline unlock request",
      35_000,
    );
    const initialPanel = await assertRequestedPanel(extensionId);
    preopenedDocumentId = initialPanel.documentId;
    record("locked-panel-preopened-through-toolbar-without-unlock-request", {
      ...preopened,
      ...initialPanel,
    });
    await screenshot("preopened-locked-panel");
    await native.detach();
    native = undefined;
  }

  setPhase("prepare-original-web-entrypoint-after-account-lock");
  const website = await browser.newPage();
  fixturePage = website;
  const fixtureUrl = "http://localhost:18081/bitwarden-inline-unlock-regression";
  await website.setRequestInterception(true);
  website.on("request", (request) => {
    if (request.url() === fixtureUrl) {
      void request.respond({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><title>Bitwarden inline unlock regression</title><h1>Inline unlock regression</h1><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="submit">Log in</button></form>',
      });
    } else {
      void request.continue().catch(() => {});
    }
  });
  await website.goto(fixtureUrl);
  record("locked-website-fixture-loaded", { origin: new URL(fixtureUrl).origin });
  setPhase("activate-website-before-original-entrypoint");
  await website.bringToFront();
  const windows = await poll(
    async () => {
      try {
        const { stdout } = await exec("xdotool", [
          "search",
          "--onlyvisible",
          "--name",
          "^Bitwarden inline unlock regression",
        ]);
        return stdout.trim().split(/\s+/);
      } catch {
        return [];
      }
    },
    (value) => value.length === 1,
    "Active website browser window",
  );
  await exec("xdotool", ["windowactivate", "--sync", windows[0]]);
  setPhase("real-web-password-field-click");
  await website.click('input[name="password"]');
  setPhase("real-inline-menu-and-unlock-click");
  const click = await clickInlineUnlock(browser, website, extensionId);
  record("real-web-inline-unlock-clicked", click);

  // From here until actual unlock: no focus(), panel click, bringToFront(), or windowactivate().
  await attachRequestedPanel(extensionId, preopenedDocumentId);
  setPhase("native-master-password-autofocus");
  const focused = await poll(
    nativeState,
    (value) =>
      value?.masterPasswordVisible &&
      value.hasFocus &&
      value.activeElement === "lock-master-password-input" &&
      value.inputType === "password",
    "Native master-password input autofocus",
    35_000,
  );
  record("native-master-password-focus-without-repair", focused);
  const firstPanel = await assertRequestedPanel(extensionId, preopenedDocumentId);
  record(
    preopenLockedPanel
      ? "first-inline-unlock-refreshed-preopened-lock-document"
      : "first-inline-unlock-opened-native-lock-document",
    firstPanel,
  );
  await screenshot("native-password-autofocus");

  setPhase("repeat-inline-unlock-refreshes-locked-panel-document");
  await website.click('input[name="password"]');
  await clickInlineUnlock(browser, website, extensionId);
  await attachRequestedPanel(extensionId, firstPanel.documentId);
  const repeated = await poll(
    nativeState,
    (value) =>
      value?.masterPasswordVisible &&
      value.hasFocus &&
      value.activeElement === "lock-master-password-input" &&
      value.inputType === "password",
    "Repeated inline Unlock focuses the replacement native lock document",
    35_000,
  );
  const refreshedPanel = await assertRequestedPanel(extensionId, firstPanel.documentId);
  record("repeated-original-inline-unlock-refreshed-lock-document-with-native-focus", {
    ...repeated,
    ...refreshedPanel,
    noFocusRepair: true,
  });
  await screenshot("native-password-repeat-autofocus");

  setPhase("os-master-password-keyboard-input");
  await native.send("Runtime.evaluate", {
    expression:
      'globalThis.__authE2EKeyEvents=[];document.addEventListener("keydown",event=>globalThis.__authE2EKeyEvents.push({trusted:event.isTrusted,enter:event.key==="Enter",target:event.target?.getAttribute("data-testid")}));',
  });
  secretInputActive = true;
  await typeSecretWithOsKeys(password);
  const typed = await poll(
    async () => {
      const value = await native.send("Runtime.evaluate", {
        expression:
          '({value:document.querySelector("[data-testid=lock-master-password-input]")?.value,hasFocus:document.hasFocus(),active:document.activeElement?.getAttribute("data-testid"),events:globalThis.__authE2EKeyEvents})',
        returnByValue: true,
      });
      const actual = value.result.value;
      return {
        matches: actual.value === password,
        hasFocus: actual.hasFocus,
        active: actual.active,
        count: actual.events.length,
        trusted:
          actual.events.length > 0 &&
          actual.events.every(
            (event) => event.trusted && event.target === "lock-master-password-input",
          ),
      };
    },
    (value) =>
      value.matches &&
      value.hasFocus &&
      value.active === "lock-master-password-input" &&
      value.trusted,
    "OS password key delivery",
  );
  assert.ok(typed.matches, "OS password input mismatch");
  record("os-password-input-matched-without-value-logging", {
    expectedValueMatched: true,
    trustedKeyEvents: typed.count,
    noFocusRepair: true,
  });
  await exec("xdotool", ["key", "--clearmodifiers", "Return"]);
  setPhase("actual-master-password-unlock-completion");
  const unlocked = await poll(
    nativeState,
    (value) =>
      !value?.lockScreen && /^#\/tabs\/vault/.test(value?.route ?? "") && value.accountButton,
    "Actual master-password unlock completed",
    90_000,
  );
  secretInputActive = false;
  record("actual-master-password-unlock-completed", unlocked);
  await screenshot("native-unlocked-vault");
  setPhase("separate-own-ui-broker-route-after-unlock");
  const requested = await native.send("Runtime.evaluate", {
    expression:
      'chrome.windows.getCurrent().then(window=>chrome.runtime.sendMessage({customSidePanel:"open",url:chrome.runtime.getURL("popup/index.html#/generator"),options:{senderWindowId:window.id}}))',
    returnByValue: true,
    awaitPromise: true,
  });
  assert.ok(
    requested.result.value?.id && !requested.result.value?.error,
    "Own-UI broker rejected the generator navigation request",
  );
  const routed = await poll(
    nativeState,
    (value) => value?.route === "#/generator",
    "Production broker routes the existing native panel to generator",
    20_000,
  );
  record("separate-own-ui-broker-navigation-after-unlock", {
    route: routed.route,
    existingNativeTarget: true,
    noFocusRepair: true,
  });
  assert.equal(report.unhandled, undefined, "Unhandled browser operation occurred");
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = {
    phase,
    name: error.name,
    message: redact(error.message),
    stack: redact(error.stack),
  };
  console.error(JSON.stringify({ phase, message: redact(error.message) }));
  process.exitCode = 1;
  // Preserve the actual test failure before optional browser diagnostics can stall.
  await mkdir("/artifacts", { recursive: true });
  await writeFile("/artifacts/report.json", redact(JSON.stringify(report, null, 2)) + "\n");
  if (browser && report.extension?.id)
    report.diagnostics = await bounded(diagnose(report.extension.id), "Failure diagnostics").catch(
      (failure) => ({ error: redact(failure) }),
    );
  if (!secretInputActive) await screenshot("failure").catch(() => {});
  else
    report.failureScreenshotOmitted =
      "A generated password may be present in the UI; the pre-entry focus screenshot and public diagnostics are preserved.";
} finally {
  if (browser) {
    try {
      await bounded(browser.close(), "Browser shutdown");
      report.browserClosed = true;
    } catch (error) {
      report.browserClosed = false;
      report.closeError = redact(error);
      report.success = false;
      process.exitCode = 1;
      const browserProcess = browser.process();
      if (
        browserProcess &&
        browserProcess.exitCode === null &&
        browserProcess.signalCode === null
      ) {
        report.browserTerminationRequested = browserProcess.kill("SIGTERM");
        await bounded(
          new Promise((resolve) => browserProcess.once("exit", resolve)),
          "Browser termination",
          2_000,
        ).catch(() => {
          if (browserProcess.exitCode === null && browserProcess.signalCode === null)
            report.browserKillRequested = browserProcess.kill("SIGKILL");
        });
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir("/artifacts", { recursive: true });
  const serialized = redact(JSON.stringify(report, null, 2)) + "\n";
  await writeFile("/artifacts/report.json", serialized);
  console.log(serialized);
}
