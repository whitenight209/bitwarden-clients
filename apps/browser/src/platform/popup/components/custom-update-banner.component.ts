import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";

import { BrowserApi } from "../../browser/browser-api";
import { CUSTOM_UPDATE_STATUS, CustomUpdateStatus } from "../../updates/custom-update-agent";

@Component({
  selector: "app-custom-update-banner",
  template: `
    @if (unlocked() === unlockedStatus && state()?.availableVersion; as version) {
      <aside
        role="status"
        aria-live="polite"
        class="tw-flex tw-items-center tw-justify-between tw-gap-2 tw-border-b tw-bg-background-alt tw-px-3 tw-py-2 tw-text-sm"
        data-testid="custom-update-banner"
      >
        <span>{{ "customUpdateNewVersion" | i18n }}: {{ version }}</span>
        <a
          routerLink="/custom-updates"
          class="tw-whitespace-nowrap tw-font-semibold tw-underline"
          data-testid="review-custom-update"
          >{{ "customUpdateReview" | i18n }}</a
        >
      </aside>
    }
  `,
  imports: [JslibModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomUpdateBannerComponent implements OnInit, OnDestroy {
  protected readonly state = signal<CustomUpdateStatus | undefined>(undefined);
  protected readonly unlockedStatus = AuthenticationStatus.Unlocked;
  protected readonly unlocked = toSignal(inject(AuthService).activeAccountStatus$);
  private readonly revision = { value: 0 };
  private readonly changed = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === "local" && changes[CUSTOM_UPDATE_STATUS]) {
      this.revision.value++;
      this.state.set(changes[CUSTOM_UPDATE_STATUS].newValue as CustomUpdateStatus | undefined);
    }
  };

  async ngOnInit(): Promise<void> {
    BrowserApi.addListener(chrome.storage.onChanged, this.changed);
    const revision = this.revision.value;
    const stored = await chrome.storage.local.get(CUSTOM_UPDATE_STATUS);
    if (revision === this.revision.value) {
      this.state.set(stored?.[CUSTOM_UPDATE_STATUS] as CustomUpdateStatus | undefined);
    }
  }

  ngOnDestroy(): void {
    BrowserApi.removeListener(chrome.storage.onChanged, this.changed);
  }
}
