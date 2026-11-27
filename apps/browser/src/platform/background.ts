import { ConsoleLogService } from "@bitwarden/common/platform/services/console-log.service";

import MainBackground from "../background/main.background";

import { SidePanelMode } from "./side-panel/side-panel-mode";
import { CustomUpdateAgent } from "./updates/custom-update-agent";

const logService = new ConsoleLogService(false);
void SidePanelMode.initializeBackground().catch((error) => logService.error(error));
const updateStartup = CustomUpdateAgent.initializeBackground().catch((error) =>
  logService.error(error),
);
const bitwardenMain = ((self as any).bitwardenMain = new MainBackground());
bitwardenMain
  .bootstrap()
  .then(async () => {
    await updateStartup;
    await CustomUpdateAgent.markHealthy();
  })
  .catch((error) => logService.error(error));
