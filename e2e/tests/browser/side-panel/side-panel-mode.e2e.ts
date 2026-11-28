import { lockAndReopen } from "../../../src/browser/account-switcher";
import { expect, popupUrl, reopenPopup, test, watchShutdown } from "../../../src/browser/fixtures";
import { clickInlineUnlock } from "../../../src/browser/inline-menu";
import { NativeSidePanel, openNativeSidePanel } from "../../../src/browser/side-panel";
import { LockScreen } from "../../../src/lock-screen";
import { LoginPage } from "../../../src/login";

const actionPopup = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const url = await chrome.action.getPopup({});
    return url ? new URL(url, chrome.runtime.getURL("/")).pathname : "";
  });

test.beforeEach(async ({ popup, context }) => {
  const login = new LoginPage(popup);
  await login.logIn();
  await login.waitForVault(/#\/tabs\//);
  await popup.goto((await popupUrl(context)) + "#/appearance");
  await expect(popup.getByTestId("side-panel-mode")).toBeVisible();
});

test("starts OFF with the existing action popup", async ({ popup }) => {
  await expect(popup.getByTestId("side-panel-mode")).not.toBeChecked();
  expect(await actionPopup(popup)).toBe("/popup/index.html");
});

test("ON removes the action popup and enables native panel behavior", async ({ popup }) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  expect(
    await popup.evaluate(
      async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick,
    ),
  ).toBe(true);
});

test("OFF restores popup behavior without reinstalling", async ({ popup }) => {
  const toggle = popup.getByTestId("side-panel-mode");
  await toggle.check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  await toggle.uncheck();
  await expect.poll(() => actionPopup(popup)).toBe("/popup/index.html");
  expect(
    await popup.evaluate(
      async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick,
    ),
  ).toBe(false);
});

test("keeps the selected mode across a complete extension reload", async ({ popup, context }) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const url = await popupUrl(context);
  const stopped = await watchShutdown(context);
  await popup.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await stopped();
  const reopened = await reopenPopup(context, url);
  await expect.poll(() => reopened.evaluate(() => chrome.action.getPopup({}))).toBe("");
  expect(
    await reopened.evaluate(
      async () =>
        (await chrome.storage.local.get("customSidePanelModeEnabled")).customSidePanelModeEnabled,
    ),
  ).toBe(true);
  expect(await reopened.evaluate(() => chrome.sidePanel.getOptions({}))).toMatchObject({
    enabled: true,
  });
});

test("ON survives account lock and reopens a native panel displaying the unlock screen", async ({
  popup,
  context,
}) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  await popup.goto((await popupUrl(context)) + "#/tabs/vault");
  const locked = await lockAndReopen(context, popup);
  await new LockScreen(locked).waitUntilShown();
  expect(await locked.evaluate(() => chrome.sidePanel.getOptions({}))).toMatchObject({
    enabled: true,
    path: "popup/index.html?uilocation=sidepanel",
  });
  expect(await locked.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const windowId = await openNativeSidePanel(locked);
  const panel = await NativeSidePanel.attach(context, locked, windowId);
  try {
    await expect
      .poll(() => panel.evaluate<boolean>("!!document.querySelector('[data-testid=lock-screen]')"))
      .toBe(true);
    expect(await locked.evaluate(() => chrome.sidePanel.getOptions({}))).toMatchObject({
      enabled: true,
    });
  } finally {
    await panel.dispose();
  }
});

test("opens a genuine SIDE_PANEL context without creating a popup window", async ({
  popup,
  context,
}) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const before = await popup.evaluate(async () => (await chrome.windows.getAll()).length);
  const windowId = await openNativeSidePanel(popup);
  const panel = await NativeSidePanel.attach(context, popup, windowId);
  try {
    await expect
      .poll(() => panel.evaluate<boolean>("!!document.querySelector('app-root router-outlet')"))
      .toBe(true);
    expect(await popup.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(before);
  } finally {
    await panel.dispose();
  }
});

for (const enabled of [false, true]) {
  test(`inline autofill Unlock opens ${enabled ? "the native panel" : "the legacy window"} after account lock`, async ({
    popup,
    context,
  }) => {
    if (enabled) {
      await popup.getByTestId("side-panel-mode").check();
      await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
    }
    const url = await popupUrl(context);
    await popup.goto(url + "#/autofill");
    await popup.locator("#show-inline-menu").check();
    await popup.goto(url + "#/tabs/vault");
    const locked = await lockAndReopen(context, popup);
    await new LockScreen(locked).waitUntilShown();
    const before = await locked.evaluate(async () => (await chrome.windows.getAll()).length);
    const website = await context.newPage();
    await website.route("http://localhost/side-panel-unlock-regression", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><title>Inline unlock regression</title><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Log in</button></form>',
      }),
    );
    await website.goto("http://localhost/side-panel-unlock-regression");
    await website.locator('input[name="username"]').click();
    await clickInlineUnlock(context, website);
    if (enabled) {
      const windowId = await locked.evaluate(async () => (await chrome.windows.getCurrent()).id!);
      let panel = await NativeSidePanel.attach(context, locked, windowId);
      try {
        await expect
          .poll(() =>
            panel.evaluate<boolean>("!!document.querySelector('[data-testid=lock-screen]')"),
          )
          .toBe(true);
        expect(await locked.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(
          before,
        );
        const unlockFocused = () =>
          panel.evaluate<boolean>(
            'document.hasFocus() && !!document.activeElement?.matches("[data-testid=lock-master-password-input], [data-testid=lock-pin-input], [data-testid=lock-biometric-unlock-button]")',
          );
        await expect.poll(unlockFocused).toBe(true);
        // Chrome must replace the locked host to return native keyboard focus to it.
        const previous = panel.targetId;
        await website.locator('input[name="username"]').click();
        await clickInlineUnlock(context, website);
        await panel.dispose();
        panel = await NativeSidePanel.attach(context, locked, windowId, previous);
        await expect.poll(unlockFocused).toBe(true);
      } finally {
        await panel.dispose();
      }
    } else {
      await expect
        .poll(() => locked.evaluate(async () => (await chrome.windows.getAll()).length))
        .toBe(before + 1);
      await expect
        .poll(() =>
          context
            .pages()
            .some((page) => page.url().includes("singleActionPopout=auth_unlockExtension")),
        )
        .toBe(true);
      const unlock = context
        .pages()
        .find((page) => page.url().includes("singleActionPopout=auth_unlockExtension"));
      expect(unlock).toBeDefined();
      await new LockScreen(unlock!).waitUntilShown();
    }
  });
}

test("routes an internal screen request inside the existing native panel", async ({
  popup,
  context,
}) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const windowId = await openNativeSidePanel(popup);
  const panel = await NativeSidePanel.attach(context, popup, windowId);
  try {
    const before = await popup.evaluate(async () => (await chrome.tabs.query({})).length);
    await popup.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          customSidePanel: "open",
          url: chrome.runtime.getURL("popup/index.html#/generator"),
          options: { senderWindowId: id },
        }),
      windowId,
    );
    await expect.poll(() => panel.evaluate<string>("location.hash")).toBe("#/generator");
    expect(await popup.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(before);
  } finally {
    await panel.dispose();
  }
});

test("routes a request to the second window without navigating the first window's panel", async ({
  popup,
  context,
}) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const firstWindow = await openNativeSidePanel(popup);
  const first = await NativeSidePanel.attach(context, popup, firstWindow);
  const secondWindow = await popup.evaluate(
    async () => (await chrome.windows.create({ url: "about:blank", type: "normal" })).id!,
  );
  let second: NativeSidePanel | undefined;
  try {
    await openNativeSidePanel(popup, secondWindow);
    second = await NativeSidePanel.attach(context, popup, secondWindow);
    const firstRoute = await first.evaluate<string>("location.hash");
    await popup.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          customSidePanel: "open",
          url: chrome.runtime.getURL("popup/index.html#/generator"),
          options: { senderWindowId: id },
        }),
      secondWindow,
    );
    await expect.poll(() => second!.evaluate<string>("location.hash")).toBe("#/generator");
    expect(await first.evaluate<string>("location.hash")).toBe(firstRoute);
  } finally {
    await first.dispose();
    await second?.dispose();
    await popup.evaluate((id) => chrome.windows.remove(id), secondWindow);
  }
});

test("queues a request when no panel is open and never silently creates a popout", async ({
  popup,
}) => {
  await popup.getByTestId("side-panel-mode").check();
  await expect.poll(() => popup.evaluate(() => chrome.action.getPopup({}))).toBe("");
  const before = await popup.evaluate(async () => (await chrome.windows.getAll()).length);
  const request = await popup.evaluate(async () =>
    chrome.runtime.sendMessage({
      customSidePanel: "open",
      url: chrome.runtime.getURL("popup/index.html#/generator"),
      options: {
        senderWindowId: (await chrome.windows.getCurrent()).id,
        singleActionKey: "e2e_pending_request",
      },
    }),
  );
  expect(request.id).toBeLessThanOrEqual(-1_000_000);
  expect(await popup.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(before);
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      customSidePanel: "close",
      key: "e2e_pending_request",
      cancelled: true,
    }),
  );
});

test("normal development builds expose an explicit unconfigured update state", async ({
  popup,
  context,
}) => {
  await popup.goto((await popupUrl(context)) + "#/custom-updates");
  await expect(popup.getByTestId("custom-updates")).toBeVisible();
  await expect(popup.getByTestId("update-status")).toContainText(/not configured/i);
  await expect(popup.getByTestId("apply-custom-update")).toHaveCount(0);
});
