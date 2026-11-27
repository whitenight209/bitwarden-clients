import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, signal } from "@angular/core";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { ButtonModule } from "@bitwarden/components";

import { BrowserApi } from "../../browser/browser-api";
import {
  CUSTOM_UPDATE_STATUS,
  CustomUpdateStatus,
  customUpdateOperation,
} from "../../updates/custom-update-agent";
import { UpdateDirectory } from "../../updates/update-files";
import { setUpdateState } from "../../updates/update-store";
import { PopupHeaderComponent } from "../layout/popup-header.component";
import { PopupPageComponent } from "../layout/popup-page.component";

@Component({
  selector: "app-custom-updates",
  templateUrl: "./custom-updates.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JslibModule, ButtonModule, PopupHeaderComponent, PopupPageComponent],
})
export class CustomUpdatesComponent implements OnInit, OnDestroy {
  protected readonly state = signal<CustomUpdateStatus | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly error = signal("");
  protected readonly statusKeys: Record<CustomUpdateStatus["status"], string> = {
    unconfigured: "customUpdateUnconfigured",
    idle: "customUpdateIdle",
    checking: "customUpdateChecking",
    available: "customUpdateAvailable",
    applying: "customUpdateApplying",
    waiting: "customUpdateWaiting",
    error: "customUpdateError",
    current: "customUpdateCurrent",
  };

  private readonly storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === "local" && changes[CUSTOM_UPDATE_STATUS]?.newValue) {
      this.state.set(changes[CUSTOM_UPDATE_STATUS].newValue as CustomUpdateStatus);
    }
  };

  async ngOnInit(): Promise<void> {
    BrowserApi.addListener(chrome.storage.onChanged, this.storageListener);
    await this.operation("state");
  }

  ngOnDestroy(): void {
    BrowserApi.removeListener(chrome.storage.onChanged, this.storageListener);
  }

  protected async operation(action: string, data: Record<string, unknown> = {}): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      this.state.set(await customUpdateOperation(action, data));
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async connectFolder(): Promise<void> {
    const picker = globalThis.window as Window & {
      showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<UpdateDirectory>;
    };
    if (!picker.showDirectoryPicker) {
      this.error.set("File System Access is unavailable in this browser.");
      return;
    }
    try {
      // The picker must run directly from this click, before IndexedDB or IPC awaits.
      const folder = await picker.showDirectoryPicker({ mode: "readwrite" });
      await setUpdateState("directoryCandidate", folder);
      await this.operation("connect");
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        this.error.set(String(error));
      }
    }
  }
}
