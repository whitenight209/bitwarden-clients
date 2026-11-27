import { Observable, Subscription } from "rxjs";

import { UnlockMethod } from "@bitwarden/unlock";

/** Observe completed unlocks, not a replayed authentication status when a view opens. */
export function checkUpdatesOnUnlock(
  events: Observable<{ method: UnlockMethod }>,
  check: () => Promise<void>,
  onError: (error: unknown) => void,
): Subscription {
  return events.subscribe(({ method }) => {
    // Restoring a saved key on worker startup is not a new user unlock.
    if (method !== UnlockMethod.AutoKey) {
      void check().catch(onError);
    }
  });
}
