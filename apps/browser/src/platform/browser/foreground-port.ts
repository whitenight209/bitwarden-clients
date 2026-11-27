/** A view-owned connection. Reconnect on user activity or send, without a periodic task. */
export class ForegroundPort {
  private port?: chrome.runtime.Port;
  private disposed = false;

  constructor(
    private readonly name: string,
    private readonly receive: (message: any) => void,
    private readonly lost: () => void = () => {},
  ) {
    globalThis.window.addEventListener("focus", this.ensureConnected);
    globalThis.window.addEventListener("pageshow", this.ensureConnected);
    this.ensureConnected();
  }

  readonly ensureConnected = (): void => {
    if (this.disposed || this.port) {
      return;
    }
    try {
      const port = chrome.runtime.connect({ name: this.name });
      if (!port?.onMessage) {
        return;
      }
      this.port = port;
      port.onMessage.addListener((message) => {
        if (this.port === port && !this.disposed) {
          this.receive(message);
        }
      });
      port.onDisconnect?.addListener(() => {
        // Chrome reports a failed connection through lastError on this event.
        void chrome.runtime.lastError;
        this.drop(port);
      });
    } catch {
      this.lost();
    }
  };

  private drop(port: chrome.runtime.Port): void {
    if (this.port === port) {
      this.port = undefined;
      this.lost();
    }
  }

  send(message: unknown): boolean {
    this.ensureConnected();
    const port = this.port;
    if (!port) {
      return false;
    }
    try {
      port.postMessage(message);
      return true;
    } catch {
      this.drop(port);
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    globalThis.window.removeEventListener("focus", this.ensureConnected);
    globalThis.window.removeEventListener("pageshow", this.ensureConnected);
    const port = this.port;
    this.port = undefined;
    this.lost();
    try {
      port?.disconnect();
    } catch {
      // The extension or view may already have been unloaded.
    }
  }
}
