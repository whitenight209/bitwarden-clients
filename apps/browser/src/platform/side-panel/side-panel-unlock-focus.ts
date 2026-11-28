const UNLOCK_KEY = "auth_unlockExtension";
const MAX_WAIT_MS = 30_000;
const UNLOCK_CONTROLS = [
  '[data-testid="lock-master-password-input"]',
  '[data-testid="lock-pin-input"]',
  '[data-testid="lock-biometric-unlock-button"]',
]
  .map((selector) => `[data-testid="lock-screen"] ${selector}`)
  .join(",");

/** One focus handoff per explicit unlock request, after the routed form is ready. */
export function focusSidePanelUnlock(win: Window, requestUrl: string): () => void {
  const requested = new URL(requestUrl);
  if (requested.searchParams.get("singleActionPopout") !== UNLOCK_KEY) {
    return () => undefined;
  }

  const doc = win.document;
  let stopped = false;
  let frame: number | undefined;
  let hadFocus = doc.hasFocus();
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    observer.disconnect();
    win.clearTimeout(deadline);
    if (frame != null) {
      win.cancelAnimationFrame(frame);
    }
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("hashchange", stop);
    win.removeEventListener("popstate", stop);
    doc.removeEventListener("visibilitychange", schedule);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const attempt = () => {
    frame = undefined;
    if (stopped) {
      return;
    }
    if (win.location.hash.split("?")[0] !== "#/lock") {
      stop();
      return;
    }
    // A forwarded click can allow window focus only during this synchronous callback.
    // Claim it even while Angular is still preparing the actual unlock control.
    win.focus();
    const control = [
      ...doc.querySelectorAll<HTMLInputElement | HTMLButtonElement>(UNLOCK_CONTROLS),
    ].find((element) => !element.matches(':disabled, [readonly], [aria-disabled="true"]'));
    if (!control) {
      // Angular may still be loading unlock options, or laying out the routed form.
      // DOM/attribute changes schedule another attempt; no fixed startup delay is assumed.
      return;
    }
    if (
      !control.getClientRects().length ||
      win.getComputedStyle(control).visibility !== "visible"
    ) {
      schedule();
      return;
    }
    control.focus({ preventScroll: true });
    if (doc.activeElement === control && doc.hasFocus()) {
      stop();
    } else {
      // The browser may hand keyboard focus to the panel after its DOM is already ready.
      schedule();
    }
  };
  function schedule() {
    if (!stopped && frame == null) {
      frame = win.requestAnimationFrame(attempt);
    }
  }
  const onBlur = () => {
    if (hadFocus) {
      stop();
    }
  };
  const onFocus = () => {
    hadFocus = true;
    schedule();
  };
  const observer = new MutationObserver(schedule);
  const deadline = win.setTimeout(stop, MAX_WAIT_MS);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);
  win.addEventListener("hashchange", stop);
  win.addEventListener("popstate", stop);
  doc.addEventListener("visibilitychange", schedule);
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  attempt();
  return stop;
}
