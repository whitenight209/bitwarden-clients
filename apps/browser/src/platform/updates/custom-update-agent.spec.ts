import { connectUpdateView } from "./custom-update-agent";

describe("update view coordination", () => {
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
    document.body.inert = false;
  });

  test("freezes a ready view until the transaction releases it", () => {
    connectUpdateView();
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
    connectUpdateView();
    receive({ type: "prepare", id: "busy" });
    expect(postMessage).toHaveBeenCalledWith({ type: "prepared", id: "busy", ready: false });
    expect(document.body.inert).toBe(false);
  });

  test("defers if an otherwise safe route contains an edited form", () => {
    const form = document.createElement("form");
    form.className = "ng-dirty";
    document.body.append(form);
    connectUpdateView();
    receive({ type: "prepare", id: "dirty" });
    expect(postMessage).toHaveBeenCalledWith({ type: "prepared", id: "dirty", ready: false });
  });

  test.each(["appearance", "custom-updates"])("allows persisted preferences on %s", (route) => {
    window.location.hash = "#/" + route;
    document.body.innerHTML = '<form class="ng-dirty"></form>';
    connectUpdateView();
    receive({ type: "prepare", id: "settings" });
    expect(postMessage).toHaveBeenCalledWith({ type: "prepared", id: "settings", ready: true });
  });

  test("releases input when the worker disconnects or the view is destroyed", () => {
    const dispose = connectUpdateView();
    receive({ type: "prepare", id: "first" });
    disconnected();
    expect(document.body.inert).toBe(false);
    receive({ type: "prepare", id: "second" });
    dispose();
    expect(document.body.inert).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
