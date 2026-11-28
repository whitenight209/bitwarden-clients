import assert from "node:assert/strict";

import { isReadyNativePanelTarget, poll, screenshot } from "./auth-browser-helpers.mjs";

export async function testPasskeyPanel({
  browser,
  background,
  extensionId,
  windowId,
  record,
  setPhase,
  lockVault,
  enterMasterPassword,
  onUnlocked,
}) {
  const url = "http://localhost:18082/passkey-panel";
  const website = await browser.newPage();
  await website.setRequestInterception(true);
  website.on("request", (request) => {
    if (request.url() === url) {
      void request.respond({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><title>Passkey panel regression</title><h1>Passkey test</h1><button id="continue-with-passkey">Continue with passkey</button>',
      });
    } else void request.continue().catch(() => {});
  });
  await website.goto(url);
  const websiteSession = await website.createCDPSession();
  const initialWindows = await background.evaluate(async () =>
    (await chrome.windows.getAll())
      .map(({ id, type }) => ({ id, type }))
      .sort((a, b) => a.id - b.id),
  );
  const prompt = "[data-bitwarden-passkey-panel]";
  const nativeContexts = () =>
    background.evaluate(
      async (id) =>
        (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).filter((context) =>
          context.documentUrl?.startsWith(`chrome-extension://${id}/popup/index.html`),
        ),
      extensionId,
    );
  const closePanel = async () => {
    await background.evaluate((id) => chrome.sidePanel.close({ windowId: id }), windowId);
    await poll(nativeContexts, (contexts) => contexts.length === 0, "Native panel closed");
  };
  const waitForQueuedRequest = () =>
    poll(
      () => background.evaluate(() => chrome.action.getBadgeText({})),
      (text) => text === "!",
      "Passkey request waits for the toolbar without a site click",
      15_000,
    );
  const openFromToolbar = async () => {
    const extension = (await browser.extensions()).get(extensionId);
    assert.ok(extension, "The extension is available for the toolbar action");
    await website.triggerExtensionAction(extension);
  };
  const isPanelTarget = (target) => isReadyNativePanelTarget(target, extensionId);
  const evaluatePanel = async (panel, expression) => {
    try {
      const response = await panel.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return response.exceptionDetails ? undefined : response.result.value;
    } catch (error) {
      if (
        /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i.test(
          error.message,
        )
      )
        return undefined;
      throw error;
    }
  };
  const assertSameWindow = async (panel) => {
    assert.equal(
      await evaluatePanel(panel, "chrome.windows.getCurrent().then(window=>window.id)"),
      windowId,
    );
    const windows = await background.evaluate(async () =>
      (await chrome.windows.getAll())
        .map(({ id, type }) => ({ id, type }))
        .sort((a, b) => a.id - b.id),
    );
    assert.deepEqual(windows, initialWindows, "Passkey request opened a separate browser window");
    assert.equal(
      (await nativeContexts()).length,
      1,
      "Passkey request created duplicate native panels",
    );
  };

  // The real RP calls WebAuthn with a real AbortSignal. Vault state, chooser and
  // credential responses all come from the extension; none is mocked.
  function startRequest(action, label) {
    const controller = new AbortController();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const result = { label, activation: navigator.userActivation.isActive, status: "pending" };
    globalThis.passkeyResults ??= {};
    globalThis.passkeyResults[label] = result;
    globalThis.passkeyAbortController = controller;
    globalThis.passkeyCurrentLabel = label;
    let request;
    try {
      request =
        action === "register"
          ? navigator.credentials.create({
              signal: controller.signal,
              publicKey: {
                challenge,
                rp: { id: "localhost", name: "Passkey regression" },
                user: {
                  id: crypto.getRandomValues(new Uint8Array(32)),
                  name: "test-passkey@example.invalid",
                  displayName: "Test passkey",
                },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: {
                  residentKey: "required",
                  userVerification: "discouraged",
                },
                timeout: 90_000,
              },
            })
          : navigator.credentials.get({
              signal: controller.signal,
              publicKey: {
                challenge,
                rpId: "localhost",
                userVerification: "discouraged",
                timeout: 90_000,
              },
            });
    } catch (error) {
      result.status = error.name || "error";
      return;
    }
    void request.then(
      (credential) => {
        try {
          const response = credential?.response;
          const client = JSON.parse(new TextDecoder().decode(response.clientDataJSON));
          const expectedChallenge = btoa(String.fromCharCode(...challenge))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          result.responseValidated =
            credential?.type === "public-key" &&
            credential.rawId.byteLength > 0 &&
            client.origin === location.origin &&
            client.challenge === expectedChallenge &&
            client.type === (action === "register" ? "webauthn.create" : "webauthn.get") &&
            (action === "register"
              ? response.attestationObject.byteLength > 0
              : response.signature.byteLength > 0 && response.authenticatorData.byteLength > 0);
          const registeredPasskeyIds = JSON.parse(
            sessionStorage.getItem("registeredPasskeys") ?? "[]",
          );
          if (action === "register" && result.responseValidated) {
            registeredPasskeyIds.push(credential.id);
            sessionStorage.setItem("registeredPasskeys", JSON.stringify(registeredPasskeyIds));
          }
          result.knownCredential =
            action === "register" || registeredPasskeyIds.includes(credential.id);
          result.status =
            result.responseValidated && result.knownCredential ? "complete" : "invalid-response";
        } catch {
          result.status = "response-validation-error";
        }
      },
      (error) => {
        result.status = error.name || "error";
      },
    );
  }
  async function begin(action, label, panelState, websiteClick = false) {
    if (panelState === "closed") await closePanel();
    else assert.equal((await nativeContexts()).length, 1, "The existing-panel fixture is not open");
    await website.bringToFront();
    setPhase(
      `passkey-${label}-${websiteClick ? "original-website-click" : "request-without-user-gesture"}`,
    );
    await poll(
      async () =>
        (
          await websiteSession.send("Runtime.evaluate", {
            expression: "navigator.userActivation.isActive",
            returnByValue: true,
            userGesture: false,
          })
        ).result.value,
      (active) => active === false,
      "No transient website user activation",
      10_000,
    );
    const request = `(${startRequest.toString()})(${JSON.stringify(action)},${JSON.stringify(label)})`;
    if (websiteClick) {
      await websiteSession.send("Runtime.evaluate", {
        expression: `(() => {
          globalThis.websitePasskeyPromptShown = false;
          const observer = new MutationObserver((records) => {
            if (records.some(record => [...record.addedNodes].some(node => node.matches?.(${JSON.stringify(prompt)})))) {
              globalThis.websitePasskeyPromptShown = true;
              observer.disconnect();
            }
          });
          observer.observe(document.documentElement, { childList: true });
          document.querySelector('#continue-with-passkey').addEventListener('click', (event) => {
            if (event.isTrusted) requestAnimationFrame(() => ${request});
          }, { once: true });
        })()`,
        userGesture: false,
      });
      await website.click("#continue-with-passkey");
      await website.waitForFunction((key) => !!globalThis.passkeyResults?.[key], {}, label);
    } else {
      await websiteSession.send("Runtime.evaluate", { expression: request, userGesture: false });
    }
    const { result } = await websiteSession.send("Runtime.evaluate", {
      expression: `globalThis.passkeyResults[${JSON.stringify(label)}].activation`,
      returnByValue: true,
      userGesture: false,
    });
    assert.equal(result.value, websiteClick);
  }
  async function attachChooser(label) {
    setPhase(`passkey-${label}-native-panel`);
    const target = await browser.waitForTarget(isPanelTarget);
    const panel = await target.createCDPSession();
    await poll(
      () =>
        evaluatePanel(
          panel,
          `({ route: location.hash.split('?')[0], ready: !!document.querySelector('app-fido2') })`,
        ),
      (state) => state?.route === "#/fido2" && state.ready,
      "Actual passkey screen in native panel",
    );
    await assertSameWindow(panel);
    await website.waitForSelector(prompt, { hidden: true });
    return panel;
  }
  async function clickPanelControl(panel, selector, description) {
    let previous;
    const target = await poll(
      () =>
        evaluatePanel(
          panel,
          `(() => {
      const button = ${selector};
      if (!button || button.disabled) return null;
      const rect=button.getBoundingClientRect(); const x=rect.x+rect.width/2, y=rect.y+rect.height/2;
      const hit=document.elementFromPoint(x,y);
      return rect.width>0&&rect.height>0&&(hit===button||button.contains(hit))?{x,y}:null;
    })()`,
        ),
      (current) => {
        const stable =
          current &&
          previous &&
          Math.abs(current.x - previous.x) < 0.5 &&
          Math.abs(current.y - previous.y) < 0.5;
        previous = current;
        return stable;
      },
      description,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await panel.send("Input.dispatchMouseEvent", {
        type,
        ...target,
        button: "left",
        clickCount: 1,
      });
  }
  const requestResult = (label) => website.evaluate((key) => globalThis.passkeyResults[key], label);
  async function approveRequest(
    action,
    label,
    panelState,
    vaultWasLocked = false,
    websiteClick = false,
  ) {
    const before = panelState === "open" ? (await nativeContexts())[0]?.documentId : undefined;
    await begin(action, label, panelState, websiteClick);
    if (panelState === "closed" && !websiteClick) {
      await waitForQueuedRequest();
      assert.deepEqual(await nativeContexts(), []);
      assert.equal(await website.$(prompt), null);
      await openFromToolbar();
    }
    if (vaultWasLocked) {
      setPhase(`passkey-${label}-unlock`);
      const target = await browser.waitForTarget(isPanelTarget);
      const lockPanel = await target.createCDPSession();
      try {
        await assertSameWindow(lockPanel);
        await poll(
          () =>
            evaluatePanel(
              lockPanel,
              `(() => {
            const [route, query] = location.hash.split('?');
            return { route, requestReceived: new URLSearchParams(query).has('sessionId') };
          })()`,
            ),
          (state) => state?.route === "#/lock" && state.requestReceived,
          "Locked panel received the WebAuthn request before unlocking",
          20_000,
        );
        assert.equal((await requestResult(label)).status, "pending");
        assert.equal(
          await evaluatePanel(lockPanel, "!!document.querySelector('app-fido2')"),
          false,
        );
        if (before) assert.equal((await nativeContexts())[0]?.documentId, before);
        await clickPanelControl(
          lockPanel,
          "document.querySelector('[data-testid=lock-master-password-input]')",
          "Visible master password field for the original passkey request",
        );
        await poll(
          () =>
            evaluatePanel(
              lockPanel,
              "document.hasFocus() && document.activeElement?.matches('[data-testid=lock-master-password-input]')",
            ),
          Boolean,
          "Clicked passkey unlock control can receive OS keys",
        );
        await enterMasterPassword(lockPanel);
        await clickPanelControl(
          lockPanel,
          "document.querySelector('[data-testid=lock-master-password-unlock-button]')",
          "Visible master password unlock submit control",
        );
      } finally {
        await lockPanel.detach().catch(() => {});
      }
    }
    const panel = await attachChooser(label);
    if (vaultWasLocked) onUnlocked();
    try {
      if (before)
        assert.equal(
          (await nativeContexts())[0]?.documentId,
          before,
          "Existing passkey panel was unexpectedly replaced",
        );
      await screenshot(`passkey-${label}-native-panel`);
      await clickPanelControl(
        panel,
        action === "register"
          ? "[...document.querySelectorAll('app-fido2 button')].find(button=>button.textContent.trim()==='Save passkey as new login')"
          : "document.querySelector('app-fido2-cipher-row button')",
        "Visible stable passkey approval control",
      );
      const result = await poll(
        () => requestResult(label),
        (value) => value.status !== "pending",
        "Original website WebAuthn request completed",
      );
      assert.equal(result.status, "complete");
      assert.ok(
        result.responseValidated && result.knownCredential,
        "WebAuthn response failed RP challenge/shape/credential checks",
      );
      if (websiteClick) {
        assert.equal(await website.evaluate(() => globalThis.websitePasskeyPromptShown), false);
      }
      await poll(
        () => evaluatePanel(panel, "!location.hash.startsWith('#/fido2')"),
        Boolean,
        "Completed passkey session left its approval screen",
      );
      record(`passkey-${label}-completed-from-native-panel`, {
        panelAlreadyOpen: panelState === "open",
        openedFromToolbar: panelState === "closed" && !websiteClick,
        activation: websiteClick,
        responseValidated: true,
        knownCredential: true,
        sameBrowserWindow: true,
        vaultWasLocked,
      });
    } finally {
      await panel.detach().catch(() => {});
    }
  }
  async function abortRequest(label, panelState) {
    await begin("assert", label, panelState);
    let panel;
    if (panelState === "closed") await waitForQueuedRequest();
    else panel = await attachChooser(label);
    try {
      setPhase(`passkey-${label}-site-aborts-real-request`);
      await website.evaluate((key) => {
        if (globalThis.passkeyCurrentLabel !== key)
          throw new Error("The RP abort fixture has no matching request");
        globalThis.passkeyAbortController.abort();
      }, label);
      const result = await poll(
        () => requestResult(label),
        (value) => value.status !== "pending",
        "RP AbortSignal rejected the original request",
      );
      assert.equal(result.status, "AbortError");
      assert.equal(await website.$(prompt), null);
      if (panel)
        await poll(
          () => evaluatePanel(panel, "!location.hash.startsWith('#/fido2')"),
          Boolean,
          "Aborted passkey chooser was dismissed",
        );
      else {
        await poll(
          () => background.evaluate(() => chrome.action.getBadgeText({})),
          (text) => text !== "!",
          "Cancelled pending passkey clears the toolbar badge",
        );
        assert.equal(
          (await nativeContexts()).length,
          0,
          "An aborted unopened request opened a native panel",
        );
      }
      record(`passkey-${label}-aborted-by-real-rp-signal`, {
        status: "AbortError",
        panelAlreadyOpen: panelState === "open",
        requestCleared: true,
      });
    } finally {
      await panel?.detach().catch(() => {});
    }
  }
  async function approveAfterVaultLock(panelState) {
    await closePanel();
    background = await lockVault();
    setPhase(`passkey-${panelState}-panel-locked-integration-ready`);
    await poll(
      () =>
        background.evaluate(async () => {
          const scriptIds = (await chrome.scripting.getRegisteredContentScripts()).map(
            (script) => script.id,
          );
          return (
            scriptIds.includes("fido2-page-script-registration") &&
            scriptIds.includes("fido2-content-script-registration")
          );
        }),
      Boolean,
      "Passkey content scripts registered after extension reload",
      20_000,
    );
    // The account lock reloads the extension, so reload the RP to install fresh content scripts.
    await website.reload();
    await poll(
      () =>
        website.evaluate(
          () =>
            !Function.prototype.toString.call(navigator.credentials.get).includes("[native code]"),
        ),
      Boolean,
      "RP has the reloaded extension's WebAuthn handler",
      20_000,
    );
    if (panelState === "open") {
      await openFromToolbar();
      const target = await browser.waitForTarget(isPanelTarget);
      const panel = await target.createCDPSession();
      try {
        await poll(
          () =>
            evaluatePanel(
              panel,
              "!!document.querySelector('[data-testid=lock-master-password-input]')",
            ),
          Boolean,
          "Toolbar-opened native panel shows the vault lock screen",
        );
      } finally {
        await panel.detach().catch(() => {});
      }
    }
    await approveRequest(
      "assert",
      `assert-locked-${panelState}-panel`,
      panelState,
      true,
      panelState === "closed",
    );
  }
  try {
    await approveRequest("register", "register", "closed");
    await approveRequest("assert", "assert-from-original-website-click", "closed", false, true);
    await approveRequest("assert", "assert", "closed");
    await approveRequest("register", "register-existing-panel", "open");
    await approveRequest("assert", "assert-existing-panel", "open");
    await abortRequest("abort-before-open", "closed");
    await approveRequest("assert", "assert-after-abort-before-open", "closed");
    await abortRequest("abort-existing-panel", "open");
    await approveRequest("assert", "assert-after-abort-existing-panel", "open");
    await approveAfterVaultLock("closed");
    await approveAfterVaultLock("open");
  } finally {
    await websiteSession.detach().catch(() => {});
  }
}
