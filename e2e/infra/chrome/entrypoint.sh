#!/bin/bash
set -euo pipefail
mkdir -p /state /artifacts
rm -f /artifacts/report.json
xvfb_pid=""
wm_pid=""
cleanup() {
  local status=$?
  if [[ ! -f /artifacts/report.json ]]; then
    E2E_STARTUP_STATUS="$status" node --input-type=module -e '
      import { writeFileSync } from "node:fs";
      writeFileSync("/artifacts/report.json", JSON.stringify({schemaVersion:1, suite:"chrome-environment", success:false, phase:"display-or-command-startup", exitCode:Number(process.env.E2E_STARTUP_STATUS), finishedAt:new Date().toISOString(), error:"The environment stopped before the test could write its report."}, null, 2) + "\n");
    ' || true
  fi
  if [[ -n "$wm_pid" ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [[ -n "$xvfb_pid" ]]; then kill "$xvfb_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp > /artifacts/xvfb.log 2>&1 &
xvfb_pid=$!
ready=false
for attempt in $(seq 1 100); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'Xvfb did not become ready.' >&2
  exit 1
fi
openbox > /artifacts/openbox.log 2>&1 &
wm_pid=$!
set +e
dbus-run-session -- "$@" 2>&1 | tee /artifacts/runtime.log
status=${PIPESTATUS[0]}
set -e
exit "$status"
