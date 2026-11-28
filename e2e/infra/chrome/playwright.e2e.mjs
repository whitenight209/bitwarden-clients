import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { registerTemporaryAccount, waitForTestServer } from "./test-server.mjs";

const report = { suite: "playwright-browser", success: false, steps: [] };
let phase = "vaultwarden-readiness";
const resultPath = "/project/playwright-results.json";
const passwords = [process.env.E2E_PASSWORD, process.env.E2E_SECOND_PASSWORD];
const redact = (text) => {
  for (const password of passwords) {
    if (password) text = text.split(password).join("[REDACTED]");
  }
  return text
    .replace(/access_token=[^\s'"&]+/g, "access_token=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
};

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "/opt/e2e/node_modules/@playwright/test/cli.js",
        "test",
        "--config=/project/e2e/playwright.browser.config.ts",
        "--reporter=json",
        "--trace=off",
      ],
      {
        cwd: "/project/e2e",
        env: {
          ...process.env,
          E2E_BROWSER_BUILD_DIR: "/extension-source",
          E2E_CHROME_EXECUTABLE: "/usr/local/bin/chrome-for-testing",
          PLAYWRIGHT_JSON_OUTPUT_FILE: resultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (output = (output + chunk).slice(-32_000)));
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (output) console.log(redact(output));
      resolve(code);
    });
  });
}

function recordTests(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        report.steps.push({
          name: spec.title,
          file: spec.file,
          status: test.status,
          success: test.status === "expected" || test.status === "flaky",
          error: last?.error?.message && redact(last.error.message),
        });
      }
    }
    recordTests(suite.suites ?? []);
  }
}

try {
  report.server = await waitForTestServer({ server: process.env.E2E_SERVER });
  phase = "temporary-accounts";
  for (const prefix of ["E2E", "E2E_SECOND"]) {
    await registerTemporaryAccount(undefined, {
      server: process.env[`${prefix}_SERVER`],
      email: process.env[`${prefix}_EMAIL`],
      password: process.env[`${prefix}_PASSWORD`],
    });
  }
  phase = "browser-playwright";
  const code = await runPlaywright();
  const results = JSON.parse(await readFile(resultPath, "utf8"));
  report.stats = results.stats;
  recordTests(results.suites);
  report.success =
    code === 0 && report.steps.length > 0 && report.steps.every((step) => step.success);
  if (!report.success) throw new Error("Playwright browser tests failed or were skipped.");
} catch (error) {
  report.error = { phase, message: redact(error.message) };
  console.error(report.error.message);
  process.exitCode = 1;
} finally {
  await writeFile("/artifacts/report.json", JSON.stringify(report, null, 2) + "\n");
}
