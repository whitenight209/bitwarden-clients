import { DatePipe } from "@angular/common";
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
import { getUpdateState, setUpdateState } from "../../updates/update-store";
import { PopupHeaderComponent } from "../layout/popup-header.component";
import { PopupPageComponent } from "../layout/popup-page.component";

@Component({
  selector: "app-custom-updates",
  templateUrl: "./custom-updates.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, JslibModule, ButtonModule, PopupHeaderComponent, PopupPageComponent],
})
export class CustomUpdatesComponent implements OnInit, OnDestroy {
  protected readonly state = signal<CustomUpdateStatus | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly error = signal("");
  private readonly folder = signal<UpdateDirectory | undefined>(undefined);
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
    let folderError: unknown;
    try {
      this.folder.set(await getUpdateState<UpdateDirectory>("directory"));
    } catch (error) {
      folderError = error;
    }
    await this.operation("state");
    if (folderError) {
      this.error.set(String(folderError));
    }
  }

  ngOnDestroy(): void {
    BrowserApi.removeListener(chrome.storage.onChanged, this.storageListener);
  }

  protected async operation(action: string, data: Record<string, unknown> = {}): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      // Call on the cached handle directly from the click, preserving user activation.
      // Chrome owns permission duration; requestPermission has no 'permanent' option.
      const folder = this.folder();
      if ((action === "apply" || action === "restore") && folder) {
        if ((await folder.requestPermission({ mode: "readwrite" })) !== "granted") {
          throw new Error("Allow access to the saved installation folder to continue.");
        }
      }
      this.state.set(await customUpdateOperation(action, data));
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async allowFolderAccess(): Promise<void> {
    const folder = this.folder();
    if (!folder) {
      return;
    }
    this.busy.set(true);
    this.error.set("");
    try {
      const permission = await folder.requestPermission({ mode: "readwrite" });
      await this.operation("state");
      if (permission !== "granted") {
        this.error.set("Folder access was not allowed. Your files have not been changed.");
      }
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
    this.busy.set(true);
    this.error.set("");
    try {
      // The picker must run directly from this click, before IndexedDB or IPC awaits.
      const folder = await picker.showDirectoryPicker({ mode: "readwrite" });
      await setUpdateState("directoryCandidate", folder);
      await this.operation("connect");
      this.folder.set(await getUpdateState<UpdateDirectory>("directory"));
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        this.error.set(String(error));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
