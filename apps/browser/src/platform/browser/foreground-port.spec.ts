import { ForegroundPort } from "./foreground-port";

function endpoint() {
  const messages: Array<(message: unknown) => void> = [];
  const closed: Array<() => void> = [];
  return {
    postMessage: jest.fn(),
    disconnect: jest.fn(),
    onMessage: { addListener: (callback: (typeof messages)[number]) => messages.push(callback) },
    onDisconnect: { addListener: (callback: () => void) => closed.push(callback) },
    message: (value: unknown) => messages.forEach((callback) => callback(value)),
    close: () => closed.forEach((callback) => callback()),
  };
}

describe("foreground port recovery", () => {
  let first: ReturnType<typeof endpoint>;
  let next: ReturnType<typeof endpoint>;
  let connection: ForegroundPort;
  let receive: jest.Mock;
  let lost: jest.Mock;
  beforeEach(() => {
    first = endpoint();
    next = endpoint();
    receive = jest.fn();
    lost = jest.fn();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: { connect: jest.fn().mockReturnValueOnce(first).mockReturnValue(next) },
      },
    });
    connection = new ForegroundPort("view", receive, lost);
  });
  afterEach(() => connection.dispose());

  test("reconnects on the next action after the worker disconnected", () => {
    first.close();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(connection.send({ action: "apply" })).toBe(true);
    expect(next.postMessage).toHaveBeenCalledWith({ action: "apply" });
  });
  test.each(["focus", "pageshow"])("reconnects on %s without a polling timer", (event) => {
    first.close();
    window.dispatchEvent(new Event(event));
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
  });
  test("handles a post/disconnect race and retries on the next action", () => {
    first.postMessage.mockImplementation(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    expect(connection.send({ first: true })).toBe(false);
    expect(connection.send({ next: true })).toBe(true);
  });
  test("ignores late messages from the old worker connection", () => {
    first.close();
    connection.ensureConnected();
    first.message("old");
    next.message("new");
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith("new");
  });
  test("disposing a view prevents subsequent focus and messages from reconnecting it", () => {
    connection.dispose();
    window.dispatchEvent(new Event("focus"));
    expect(connection.send("ignored")).toBe(false);
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
  });
});
