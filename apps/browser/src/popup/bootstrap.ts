import { enableProdMode, provideZoneChangeDetection } from "@angular/core";
import { platformBrowser } from "@angular/platform-browser";

import { BrowserPlatformUtilsService } from "../platform/services/platform-utils/browser-platform-utils.service";
import { SidePanelMode } from "../platform/side-panel/side-panel-mode";

import { AppModule } from "./app.module";

// Should be removed once we deprecate support for Safari 16.0 and older. See Jira ticket [PM-1861]
if (BrowserPlatformUtilsService.shouldApplySafariHeightFix(window)) {
  document.documentElement.classList.add("safari_height_fix");
}

if (process.env.ENV === "production") {
  enableProdMode();
}

function init() {
  void platformBrowser().bootstrapModule(AppModule, {
    applicationProviders: [provideZoneChangeDetection()],
  });
}

if (SidePanelMode.prepareViewDocument()) {
  init();
}
