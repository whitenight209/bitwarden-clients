import { Subject } from "rxjs";

import { UnlockMethod } from "@bitwarden/unlock";

import { checkUpdatesOnUnlock } from "./update-unlock-trigger";

test.each([
  UnlockMethod.MasterPassword,
  UnlockMethod.Pin,
  UnlockMethod.Biometrics,
  UnlockMethod.Prf,
  UnlockMethod.SharedUnlock,
  UnlockMethod.DecryptedUserKey,
  UnlockMethod.KeyConnector,
])("checks on a completed %s unlock", (method) => {
  const events = new Subject<{ method: UnlockMethod }>();
  const check = jest.fn().mockResolvedValue(undefined);
  const subscription = checkUpdatesOnUnlock(events, check, jest.fn());
  expect(check).not.toHaveBeenCalled();
  events.next({ method });
  expect(check).toHaveBeenCalledTimes(1);
  subscription.unsubscribe();
});

test("restoring an auto-unlock key on worker startup never starts a check", () => {
  const events = new Subject<{ method: UnlockMethod }>();
  const check = jest.fn().mockResolvedValue(undefined);
  const subscription = checkUpdatesOnUnlock(events, check, jest.fn());
  events.next({ method: UnlockMethod.AutoKey });
  expect(check).not.toHaveBeenCalled();
  subscription.unsubscribe();
});

test("a pending or failed update request does not hold up unlock completion", async () => {
  const events = new Subject<{ method: UnlockMethod }>();
  let rejectCheck!: (error: Error) => void;
  const check = jest.fn(
    () =>
      new Promise<void>((_, reject) => {
        rejectCheck = reject;
      }),
  );
  const error = jest.fn();
  const subscription = checkUpdatesOnUnlock(events, check, error);
  events.next({ method: UnlockMethod.Pin });
  expect(check).toHaveBeenCalledTimes(1);
  rejectCheck(new Error("Offline"));
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Offline" }));
  subscription.unsubscribe();
});
