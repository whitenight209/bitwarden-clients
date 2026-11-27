import { TestBed, ComponentFixture } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { BehaviorSubject } from "rxjs";

import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";

import { BrowserApi } from "../../browser/browser-api";
import { CUSTOM_UPDATE_STATUS } from "../../updates/custom-update-agent";

import { CustomUpdateBannerComponent } from "./custom-update-banner.component";

describe("custom update notification", () => {
  let fixture: ComponentFixture<CustomUpdateBannerComponent>;
  let auth: BehaviorSubject<AuthenticationStatus>;
  let change: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const current = {
    configured: true,
    connected: true,
    status: "available",
    version: "1.0.0.1",
    availableVersion: "1.0.0.2",
  };

  beforeEach(async () => {
    auth = new BehaviorSubject(AuthenticationStatus.Unlocked);
    jest.spyOn(BrowserApi, "addListener").mockImplementation((_event, listener) => {
      change = listener;
    });
    jest.spyOn(BrowserApi, "removeListener").mockImplementation();
    jest
      .spyOn(chrome.storage.local, "get")
      .mockResolvedValue({ [CUSTOM_UPDATE_STATUS]: current } as never);
    jest.spyOn(chrome.runtime, "sendMessage").mockClear();
    await TestBed.configureTestingModule({
      imports: [CustomUpdateBannerComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { activeAccountStatus$: auth } },
        { provide: I18nService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CustomUpdateBannerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  test("shows the cached version and a review link without checking or installing", () => {
    expect(fixture.nativeElement.textContent).toContain("1.0.0.2");
    expect(fixture.nativeElement.querySelector("a").getAttribute("href")).toContain(
      "/custom-updates",
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
  test("hides the notification when locked and restores it after unlock", () => {
    auth.next(AuthenticationStatus.Locked);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("aside")).toBeNull();
    auth.next(AuthenticationStatus.Unlocked);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("aside")).not.toBeNull();
  });
  test("refreshes a notification when the unlock check publishes a new version", () => {
    change(
      { [CUSTOM_UPDATE_STATUS]: { newValue: { ...current, availableVersion: "1.0.0.3" } } },
      "local",
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("1.0.0.3");
  });
  test("clears the banner once no update remains", () => {
    change(
      { [CUSTOM_UPDATE_STATUS]: { newValue: { ...current, availableVersion: undefined } } },
      "local",
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("aside")).toBeNull();
  });

  test("a slow initial cache read cannot overwrite a newer notification", async () => {
    fixture.destroy();
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    jest.spyOn(chrome.storage.local, "get").mockReturnValueOnce(pending as never);
    fixture = TestBed.createComponent(CustomUpdateBannerComponent);
    fixture.detectChanges();
    change(
      { [CUSTOM_UPDATE_STATUS]: { newValue: { ...current, availableVersion: "1.0.0.3" } } },
      "local",
    );
    resolve({ [CUSTOM_UPDATE_STATUS]: current });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("1.0.0.3");
  });
});
