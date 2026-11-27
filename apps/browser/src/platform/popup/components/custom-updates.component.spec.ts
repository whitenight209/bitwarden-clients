import { BrowserApi } from "../../browser/browser-api";
import { customUpdateOperation } from "../../updates/custom-update-agent";
import { UpdateDirectory } from "../../updates/update-files";
import { getUpdateState } from "../../updates/update-store";

import { CustomUpdatesComponent } from "./custom-updates.component";

jest.mock("../../updates/update-store", () => ({
  getUpdateState: jest.fn(),
  setUpdateState: jest.fn(),
}));
jest.mock("../../updates/custom-update-agent", () => ({ customUpdateOperation: jest.fn() }));

class Screen extends CustomUpdatesComponent {
  apply = () => this.operation("apply");
  restore = () => this.operation("restore");
  allow = () => this.allowFolderAccess();
  failure = () => this.error();
}
let screen: Screen;
let request: jest.Mock;
beforeEach(async () => {
  jest.spyOn(BrowserApi, "addListener").mockImplementation();
  jest.spyOn(BrowserApi, "removeListener").mockImplementation();
  request = jest.fn().mockResolvedValue("granted");
  jest
    .mocked(getUpdateState)
    .mockResolvedValue({ requestPermission: request } as unknown as UpdateDirectory);
  jest.mocked(customUpdateOperation).mockResolvedValue({
    configured: true,
    connected: true,
    version: "1.0.0.1",
    status: "available",
  });
  screen = new Screen();
  await screen.ngOnInit();
  jest.mocked(customUpdateOperation).mockClear();
});
afterEach(() => {
  screen.ngOnDestroy();
  jest.restoreAllMocks();
});

test.each(["apply", "restore"] as const)(
  "%s asks permission synchronously on the saved handle before IPC",
  async (operation) => {
    const pending = screen[operation]();
    expect(request).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(customUpdateOperation).not.toHaveBeenCalled();
    await pending;
    expect(customUpdateOperation).toHaveBeenCalledWith(operation, {});
  },
);
test("reuses the saved handle to request renewed access, without a new folder picker", async () => {
  await screen.allow();
  expect(request).toHaveBeenCalledTimes(1);
  expect(customUpdateOperation).toHaveBeenCalledWith("state", {});
});
test.each(["prompt", "denied"])(
  "does not apply files when permission remains %s",
  async (permission) => {
    request.mockResolvedValue(permission);
    await screen.apply();
    expect(customUpdateOperation).not.toHaveBeenCalled();
    expect(screen.failure()).toContain("Allow access");
  },
);
test("opening the screen never requests file access or checks for releases", () => {
  expect(request).not.toHaveBeenCalled();
  expect(customUpdateOperation).not.toHaveBeenCalled();
});
test("a dismissed or rejected permission prompt leaves the updater untouched", async () => {
  request.mockRejectedValue(new DOMException("Dismissed", "AbortError"));
  await screen.apply();
  expect(customUpdateOperation).not.toHaveBeenCalled();
  expect(screen.failure()).toContain("Dismissed");
});
