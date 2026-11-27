import { connectUpdateView, customUpdateOperation } from "./custom-update-agent";

describe("update view coordination", () => {
  let broadcast: (message: unknown, sender: chrome.runtime.MessageSender) => void;
  let dispose: () => void;
  let receive: (message: unknown) => void;
  let disconnected: () => void;
  let postMessage: jest.Mock;
  let disconnect: jest.Mock;

  beforeEach(() => {
    postMessage = jest.fn();
    disconnect = jest.fn();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          id: "test",
          onMessage: {
            addListener: (listener: typeof broadcast) => {
              broadcast = listener;
            },
            removeListener: jest.fn(),
          },
          connect: jest.fn(() => ({
            postMessage,
            disconnect,
            onMessage: {
              addListener: (listener: typeof receive) => {
                receive = listener;
              },
            },
            onDisconnect: {
              addListener: (listener: typeof disconnected) => {
                disconnected = listener;
              },
            },
          })),
        },
      },
    });
    document.body.replaceChildren();
    document.body.inert = false;
    window.location.hash = "#/tabs/vault";
  });

  afterEach(() => {
    dispose?.();
    document.body.inert = false;
  });

  test("freezes a ready view until the transaction releases it", () => {
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "transaction" });
    expect(postMessage).toHaveBeenCalledWith({ type: "prepared", id: "transaction", ready: true });
    expect(document.body.inert).toBe(true);
    receive({ type: "release" });
    expect(document.body.inert).toBe(false);
  });

  test.each([
    "add-cipher",
    "edit-cipher?cipherId=123",
    "attachments",
    "import",
    "import-from-file",
    "fido2",
    "http-authentication",
    "2fa",
    "sso",
  ])("defers an update while %s is active", (route) => {
    window.location.hash = "#/" + route;
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "transaction" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prepared",
        id: "transaction",
        ready: false,
        reason: expect.any(String),
      }),
    );
    expect(document.body.inert).toBe(false);
  });

  test("defers if an otherwise safe route contains an edited form", () => {
    const form = document.createElement("form");
    form.className = "ng-dirty";
    document.body.append(form);
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "transaction" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prepared",
        id: "transaction",
        ready: false,
        reason: expect.any(String),
      }),
    );
  });

  test.each(["appearance", "custom-updates"])("allows persisted preferences on %s", (route) => {
    window.location.hash = "#/" + route;
    document.body.innerHTML = '<form class="ng-dirty"></form>';
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "transaction" });
    expect(postMessage).toHaveBeenCalledWith({ type: "prepared", id: "transaction", ready: true });
  });

  test("opens no connection when a view opens or when ordinary operations run", async () => {
    dispose = connectUpdateView();
    chrome.runtime.sendMessage = jest.fn(async () => ({
      status: "available",
    })) as typeof chrome.runtime.sendMessage;
    await customUpdateOperation("state");
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });

  test("releases input when the transaction disconnects and accepts the next transaction", () => {
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "transaction" });
    expect(document.body.inert).toBe(true);
    disconnected();
    expect(document.body.inert).toBe(false);
    broadcast({ customExtensionUpdatePrepare: "retry" }, { id: "test" });
    receive({ type: "prepare", id: "retry" });
    expect(document.body.inert).toBe(true);
    dispose();
    expect(document.body.inert).toBe(false);
  });

  test("ignores broadcasts from other extensions and mismatched transactions", () => {
    dispose = connectUpdateView();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "other" });
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    broadcast({ customExtensionUpdatePrepare: "transaction" }, { id: "test" });
    receive({ type: "prepare", id: "other" });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
