import { focusSidePanelUnlock } from "./side-panel-unlock-focus";

const request =
  "chrome-extension://test/popup/index.html?uilocation=sidepanel&singleActionPopout=auth_unlockExtension#/lock";
let stop: () => void;
let oldUrl: string;
let focused: boolean;

function addControl(testId = "lock-master-password-input", disabled = false) {
  const screen =
    document.querySelector('[data-testid="lock-screen"]') ??
    document.body.appendChild(document.createElement("div"));
  screen.setAttribute("data-testid", "lock-screen");
  const input = document.createElement(
    testId === "lock-biometric-unlock-button" ? "button" : "input",
  );
  input.dataset.testid = testId;
  input.disabled = disabled;
  jest.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  screen.append(input);
  return input;
}

async function renderFrame() {
  await Promise.resolve(); // MutationObserver sees the routed form appear.
  await jest.advanceTimersByTimeAsync(20);
}

beforeEach(() => {
  jest.useFakeTimers();
  oldUrl = window.location.href;
  window.history.replaceState(null, "", "/?uilocation=sidepanel#/lock");
  document.body.innerHTML = "";
  focused = true;
  jest.spyOn(document, "hasFocus").mockImplementation(() => focused);
  jest.spyOn(window, "focus").mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", oldUrl);
});

test("waits for a slow routed unlock form instead of relying on a startup delay", async () => {
  stop = focusSidePanelUnlock(window, request);
  expect(window.focus).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(10_000);
  expect(window.focus).toHaveBeenCalledTimes(1);
  const input = addControl();
  await renderFrame();
  expect(window.focus).toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  expect(jest.getTimerCount()).toBe(0);
});

test("waits until a disabled input is enabled", async () => {
  const input = addControl("lock-master-password-input", true);
  stop = focusSidePanelUnlock(window, request);
  await renderFrame();
  expect(document.activeElement).not.toBe(input);
  input.disabled = false;
  await renderFrame();
  expect(document.activeElement).toBe(input);
});

test("waits for layout before focusing", async () => {
  const input = addControl();
  jest.mocked(input.getClientRects).mockReturnValue([] as unknown as DOMRectList);
  stop = focusSidePanelUnlock(window, request);
  await renderFrame();
  expect(window.focus).toHaveBeenCalled();
  expect(document.activeElement).not.toBe(input);
  jest.mocked(input.getClientRects).mockReturnValue([{}] as unknown as DOMRectList);
  await renderFrame();
  expect(document.activeElement).toBe(input);
});

test.each(["lock-pin-input", "lock-biometric-unlock-button"])(
  "respects the displayed unlock method %s",
  async (testId) => {
    const input = addControl(testId);
    stop = focusSidePanelUnlock(window, request);
    await renderFrame();
    expect(document.activeElement).toBe(input);
  },
);

test("does not settle until the panel document owns keyboard focus", async () => {
  focused = false;
  const input = addControl();
  stop = focusSidePanelUnlock(window, request);
  await renderFrame();
  expect(document.activeElement).toBe(input);
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  await renderFrame();
  expect(jest.getTimerCount()).toBe(0);
});

test("stops after success and does not reclaim focus from another input", async () => {
  addControl();
  stop = focusSidePanelUnlock(window, request);
  await renderFrame();
  const other = document.body.appendChild(document.createElement("input"));
  other.focus();
  await renderFrame();
  expect(document.activeElement).toBe(other);
});

test.each(["pointerdown", "keydown", "hashchange", "popstate", "blur"])(
  "cancels a slow request when %s indicates the user moved on",
  async (event) => {
    stop = focusSidePanelUnlock(window, request);
    (event === "pointerdown" || event === "keydown" ? document : window).dispatchEvent(
      new Event(event),
    );
    const input = addControl();
    await renderFrame();
    expect(document.activeElement).not.toBe(input);
    expect(jest.getTimerCount()).toBe(0);
  },
);

test("ignores other side panel requests", async () => {
  const input = addControl();
  stop = focusSidePanelUnlock(window, request.replace("auth_unlockExtension", "vault_Fido2Popout"));
  await renderFrame();
  expect(document.activeElement).not.toBe(input);
  expect(window.focus).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("focuses a ready unlock control synchronously while the initiating gesture is available", () => {
  const input = addControl();
  input.value = "preserve-current-input";
  stop = focusSidePanelUnlock(window, request);
  expect(window.focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("preserve-current-input");
  expect(jest.getTimerCount()).toBe(0);
});

test("does not focus a different route even when the request is an unlock", () => {
  window.history.replaceState(null, "", "/?uilocation=sidepanel#/tabs/vault");
  stop = focusSidePanelUnlock(window, request);
  expect(window.focus).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("expires without late focus when the form never finishes loading", async () => {
  stop = focusSidePanelUnlock(window, request);
  jest.advanceTimersByTime(30_000);
  const input = addControl();
  await renderFrame();
  expect(document.activeElement).not.toBe(input);
  expect(jest.getTimerCount()).toBe(0);
});

test("cancels when navigation changed before the next rendered frame", async () => {
  stop = focusSidePanelUnlock(window, request);
  window.history.replaceState(null, "", "/?uilocation=sidepanel#/tabs/vault");
  const input = addControl();
  await renderFrame();
  expect(document.activeElement).not.toBe(input);
  expect(jest.getTimerCount()).toBe(0);
});
