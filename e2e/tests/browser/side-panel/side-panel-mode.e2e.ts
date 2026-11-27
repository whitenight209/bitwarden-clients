import { expect, popupUrl, reopenPopup, test, watchShutdown } from "../../../src/browser/fixtures";
import { NativeSidePanel, openNativeSidePanel } from "../../../src/browser/side-panel";
import { LoginPage } from "../../../src/login";

test.beforeEach(async ({ popup, context }) => {
  const login = new LoginPage(popup);
  await login.logIn();
  await login.waitForVault(/#\/tabs\//);
  await popup.goto((await popupUrl(context)) + "#/appearance");
  await expect(popup.getByTestId("side-panel-mode")).toBeVisible();
});

test("starts OFF with the existing action popup", async ({ popup }) => {
  await expect(popup.getByTestId("side-panel-mode")).not.toBeChecked();
  expect(await popup.evaluate(() => chrome.action.getPopup({}))).toBe("popup/index.html");
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
  await expect
    .poll(() => popup.evaluate(() => chrome.action.getPopup({})))
    .toBe("popup/index.html");
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
