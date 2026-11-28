#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const options = {
  extension: resolve(repository, "apps/browser/build"),
  forceFailure: false,
  keepVm: false,
  preopenPanel: false,
  passkeyPanel: false,
  setupOnly: false,
  suite: "authenticated",
  provider: process.platform === "darwin" ? "colima" : "docker",
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--extension" && args[i + 1]) options.extension = resolve(args[++i]);
  else if (args[i] === "--force-failure") options.forceFailure = true;
  else if (args[i] === "--keep-vm") options.keepVm = true;
  else if (args[i] === "--preopen-panel") options.preopenPanel = true;
  else if (args[i] === "--passkey-panel") options.passkeyPanel = true;
  else if (args[i] === "--setup-only") options.setupOnly = true;
  else if (
    args[i] === "--suite" &&
    ["environment", "authenticated", "playwright"].includes(args[i + 1])
  )
    options.suite = args[++i];
  else if (args[i] === "--provider" && ["colima", "docker"].includes(args[i + 1]))
    options.provider = args[++i];
  else if (args[i] === "--help") {
    console.log(
      "Usage: node e2e/infra/chrome/run.mjs [--setup-only] [--extension DIR] [--suite authenticated|environment|playwright] [--provider colima|docker] [--preopen-panel] [--passkey-panel] [--force-failure] [--keep-vm]",
    );
    process.exit(0);
  } else {
    console.error(`Unknown or incomplete option: ${args[i]}`);
    process.exit(2);
  }
}

if (
  options.passkeyPanel &&
  (options.setupOnly || options.preopenPanel || options.suite !== "authenticated")
) {
  console.error("--passkey-panel requires the authenticated E2E suite without --preopen-panel.");
  process.exit(2);
}

if (options.setupOnly && (options.preopenPanel || options.forceFailure)) {
  console.error("--preopen-panel and --force-failure require an E2E run.");
  process.exit(2);
}
if (options.suite === "playwright" && (options.preopenPanel || options.forceFailure)) {
  console.error("--preopen-panel and --force-failure are unavailable for the Playwright suite.");
  process.exit(2);
}

const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const profile = "bitwarden-e2e";
const context =
  options.provider === "colima"
    ? "colima-bitwarden-e2e"
    : (process.env.DOCKER_CONTEXT ?? "default");
const image = "bitwarden-chrome-e2e:local";
const name = `bitwarden-chrome-e2e-${runId}`;
const volumeNames = [`${name}-source`, `${name}-state`, `${name}-artifacts`];
const serverName = `${name}-server`;
const serverImage =
  "vaultwarden/server:1.37.5@sha256:4fe17f415f90087377d37c755e0ea3cf189dcc6794e49cdd2a9adbb4937d9e1f";
const needsVault = options.suite !== "environment";
const playwright = options.suite === "playwright";
const credentials =
  !options.setupOnly && needsVault
    ? {
        E2E_SERVER: "https://localhost:8080",
        E2E_EMAIL: `chrome-e2e-${runId}@example.invalid`,
        E2E_PASSWORD: randomBytes(24).toString("base64url") + "Aa1!",
      }
    : {};
if (!options.setupOnly && playwright) {
  credentials.E2E_SECOND_SERVER = credentials.E2E_SERVER;
  credentials.E2E_SECOND_EMAIL = `chrome-e2e-${runId}-second@example.invalid`;
  credentials.E2E_SECOND_PASSWORD = randomBytes(24).toString("base64url") + "Aa1!";
}
if (needsVault) volumeNames.push(`${name}-server-data`, `${name}-tls`);
const output = join(repository, ".debug/chrome-e2e", runId);
const lock = join(repository, ".debug/chrome-e2e/active.lock");
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: "running",
  setupOnly: options.setupOnly,
  suite: options.suite,
  provider: options.provider,
  scope: options.setupOnly
    ? "Prepare the Docker engine and cache images for a later Chrome E2E run."
    : playwright
      ? "Run the browser Playwright suite against an isolated Vaultwarden with two temporary accounts."
      : needsVault
        ? "Temporary local account: login, lock, website inline Unlock, native side-panel password focus and OS keyboard delivery."
        : "Chrome environment E2E; authenticated vault/master-password unlock is not tested.",
  profile,
  context,
  extension: options.setupOnly ? undefined : options.extension,
  intentionallyFailing: options.forceFailure,
  preopenPanel: options.preopenPanel,
  passkeyPanel: options.passkeyPanel,
  steps: [],
  cleanup: [],
};
const children = new Set();
const containers = new Set();
const volumes = new Set();
let ownsLock = false;
let startedVm = false;
let cleaning = false;
let signal;
let mainContainerCreated = false;

for (const name of ["SIGINT", "SIGTERM"])
  process.on(name, () => {
    signal ??= name;
    if (!cleaning)
      for (const child of children) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (children.has(child)) child.kill("SIGKILL");
        }, 3000).unref();
      }
  });

await mkdir(output, { recursive: true });
const log = join(output, "commands.log");
const redact = (value) => {
  let text = String(value);
  for (const password of [credentials.E2E_PASSWORD, credentials.E2E_SECOND_PASSWORD]) {
    if (password) text = text.split(password).join("[REDACTED]");
  }
  return text.replace(/access_token=[^\s'"&]+/g, "access_token=[REDACTED]");
};
const errorInfo = (error) => ({
  name: error.name,
  message: redact(error.message),
  code: error.code,
});
async function command(
  program,
  args,
  { timeout = 120_000, allowFailure = false, cleanup = false, env = {} } = {},
) {
  if (signal && !cleanup) throw new Error(`Interrupted by ${signal}`);
  const logCommand = appendFile(log, redact(`\n$ ${program} ${args.join(" ")}\n`));
  if (cleanup) await logCommand.catch(() => {});
  else await logCommand;
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: repository,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeout);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      children.delete(child);
      const logOutput = appendFile(log, redact(stdout + stderr));
      void (cleanup ? logOutput.catch(() => {}) : logOutput).then(() => {
        if (timedOut || (!allowFailure && code !== 0)) {
          const error = new Error(
            `${program} failed (${timedOut ? "timeout" : (terminationSignal ?? code)}): ${(stderr || stdout).slice(-3000)}`,
          );
          error.code = code;
          reject(error);
        } else resolve({ stdout, stderr, code });
      }, reject);
    });
  });
}
const docker = (args, options) => command("docker", ["--context", context, ...args], options);
async function removeResource(args) {
  const result = await docker(args, { cleanup: true, allowFailure: true });
  if (result.code !== 0 && !/No such (container|volume)/i.test(result.stderr)) {
    throw new Error(`Resource cleanup failed: ${result.stderr}`);
  }
}
async function step(name, action) {
  const entry = { name, startedAt: new Date().toISOString() };
  report.steps.push(entry);
  console.log(name);
  try {
    entry.result = await action();
    entry.status = "passed";
    return entry.result;
  } catch (error) {
    entry.status = "failed";
    entry.error = errorInfo(error);
    throw error;
  } finally {
    entry.finishedAt = new Date().toISOString();
  }
}
async function cleanupStep(name, action) {
  const entry = { name };
  report.cleanup.push(entry);
  try {
    await action();
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = errorInfo(error);
  }
}

try {
  await step(
    options.provider === "colima" ? "Check Colima and Docker CLI" : "Check Docker CLI",
    async () => {
      await mkdir(lock);
      ownsLock = true;
      await writeFile(join(lock, "owner.json"), JSON.stringify({ runId, pid: process.pid }));
      const colima =
        options.provider === "colima" ? await command("colima", ["version"]) : undefined;
      const docker = await command("docker", ["--version"]);
      return { colima: colima?.stdout.trim(), docker: docker.stdout.trim() };
    },
  );
  if (!options.setupOnly) {
    await step("Check extension build", async () => {
      const manifest = JSON.parse(await readFile(join(options.extension, "manifest.json"), "utf8"));
      if (
        manifest.manifest_version !== 3 ||
        !manifest.background?.service_worker ||
        !manifest.side_panel
      ) {
        throw new Error("Expected a built Manifest V3 extension with a side panel.");
      }
      return { version: manifest.version };
    });
  }
  await step(
    options.provider === "colima"
      ? "Start or verify the dedicated Colima VM"
      : "Verify the Docker engine",
    async () => {
      if (options.provider === "colima") {
        const list = await command("colima", ["list", "--json"]);
        const vm = list.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((vm) => vm.name === profile);
        report.vmWasAlreadyRunning = vm?.status === "Running";
        if (!report.vmWasAlreadyRunning) {
          startedVm = true;
          await command(
            "colima",
            [
              "start",
              profile,
              "--activate=false",
              "--vm-type",
              "vz",
              "--arch",
              "aarch64",
              "--cpus",
              "2",
              "--memory",
              "4",
              "--disk",
              "40",
              "--runtime",
              "docker",
              "--mount",
              "none",
              "--ssh-config=false",
              "--binfmt=false",
            ],
            { timeout: 300_000 },
          );
        }
      }
      const engine = await docker([
        "info",
        "--format",
        "{{json .ServerVersion}} {{json .OSType}} {{json .Architecture}}",
      ]);
      return { alreadyRunning: report.vmWasAlreadyRunning, engine: engine.stdout.trim() };
    },
  );
  await step("Build the Chrome environment image", async () => {
    await docker(["build", "--tag", image, here], { timeout: 900_000 });
    return { image };
  });
  if (needsVault) {
    await step("Cache the pinned Vaultwarden image", async () => {
      await docker(["pull", serverImage], { timeout: 300_000 });
      return { image: serverImage };
    });
  }
  if (!options.setupOnly) await runE2E();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = errorInfo(error);
} finally {
  await finish();
}

async function runE2E() {
  await step("Prepare isolated test containers and volumes", async () => {
    for (const volume of volumeNames) {
      volumes.add(volume);
      await docker(["volume", "create", "--label", `bitwarden.e2e.run=${runId}`, volume]);
    }
    const copier = `${name}-source`;
    containers.add(copier);
    await docker([
      "create",
      "--name",
      copier,
      "--label",
      `bitwarden.e2e.run=${runId}`,
      "--volume",
      `${volumeNames[0]}:/extension-source`,
      ...(playwright ? ["--volume", `${volumeNames[1]}:/project/e2e`] : []),
      "--entrypoint",
      "/bin/true",
      image,
    ]);
    await docker(["cp", `${options.extension}/.`, `${copier}:/extension-source`]);
    if (playwright) {
      for (const path of ["src", "tests", "playwright.base.ts", "playwright.browser.config.ts"]) {
        await docker(["cp", join(repository, "e2e", path), `${copier}:/project/e2e/`]);
      }
    }
    await docker(["rm", copier]);
    containers.delete(copier);
    if (needsVault) {
      const tlsContainer = `${name}-tls`;
      containers.add(tlsContainer);
      await docker([
        "run",
        "--name",
        tlsContainer,
        "--label",
        `bitwarden.e2e.run=${runId}`,
        "--volume",
        `${volumeNames[4]}:/tls`,
        "--entrypoint",
        "openssl",
        image,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        "/tls/key.pem",
        "-out",
        "/tls/cert.pem",
      ]);
      await docker(["cp", `${tlsContainer}:/tls/cert.pem`, join(output, "test-server-cert.pem")]);
      const { X509Certificate, createHash } = await import("node:crypto");
      const certificate = new X509Certificate(await readFile(join(output, "test-server-cert.pem")));
      credentials.E2E_TLS_SPKI = createHash("sha256")
        .update(certificate.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64");
      await docker(["rm", tlsContainer]);
      containers.delete(tlsContainer);
      containers.add(serverName);
      await docker([
        "create",
        "--name",
        serverName,
        "--label",
        `bitwarden.e2e.run=${runId}`,
        "--volume",
        `${volumeNames[3]}:/data`,
        "--volume",
        `${volumeNames[4]}:/tls:ro`,
        "--env",
        "ROCKET_ADDRESS=127.0.0.1",
        "--env",
        "ROCKET_PORT=8080",
        "--env",
        "DOMAIN=https://localhost:8080",
        "--env",
        'ROCKET_TLS={certs="/tls/cert.pem",key="/tls/key.pem"}',
        "--env",
        "SIGNUPS_ALLOWED=true",
        "--env",
        "SIGNUPS_VERIFY=false",
        "--env",
        "WEB_VAULT_ENABLED=true",
        "--env",
        "DISABLE_ICON_DOWNLOAD=true",
        serverImage,
      ]);
      await docker(["start", serverName]);
      const state = JSON.parse(
        (await docker(["inspect", "--format", "{{json .State}}", serverName])).stdout,
      );
      if (!state.Running) throw new Error("The temporary vault server did not start.");
      report.server = {
        name: serverName,
        image: serverImage,
        url: credentials.E2E_SERVER,
        email: credentials.E2E_EMAIL,
      };
    }
    containers.add(name);
    await docker(
      [
        "create",
        "--init",
        "--name",
        name,
        "--label",
        `bitwarden.e2e.run=${runId}`,
        "--shm-size",
        "1g",
        "--volume",
        `${volumeNames[0]}:/extension-source:ro`,
        "--volume",
        `${volumeNames[1]}:${playwright ? "/project/e2e" : "/state"}`,
        "--volume",
        `${volumeNames[2]}:/artifacts`,
        "--env",
        `E2E_FORCE_FAILURE=${options.forceFailure ? "1" : "0"}`,
        "--env",
        `E2E_PREOPEN_LOCKED_PANEL=${options.preopenPanel ? "1" : "0"}`,
        "--env",
        `E2E_PASSKEY_PANEL=${options.passkeyPanel ? "1" : "0"}`,
        ...(needsVault
          ? [
              "--network",
              `container:${serverName}`,
              "--env",
              "E2E_SERVER",
              "--env",
              "E2E_EMAIL",
              "--env",
              "E2E_PASSWORD",
              "--env",
              "E2E_TLS_SPKI",
              "--env",
              "NODE_EXTRA_CA_CERTS=/tls/cert.pem",
              "--volume",
              `${volumeNames[4]}:/tls:ro`,
            ]
          : []),
        ...(playwright
          ? [
              "--env",
              "E2E_SECOND_SERVER",
              "--env",
              "E2E_SECOND_EMAIL",
              "--env",
              "E2E_SECOND_PASSWORD",
              "--env",
              "NODE_PATH=/opt/e2e/node_modules",
            ]
          : []),
        image,
        "node",
        `/opt/e2e/${options.suite}.e2e.mjs`,
      ],
      { env: credentials },
    );
    mainContainerCreated = true;
    return { container: name };
  });
  await step(`Run headed Chrome ${options.suite} E2E`, async () => {
    const attached = await docker(["start", "--attach", name], {
      timeout: playwright ? 1_200_000 : needsVault ? 420_000 : 240_000,
      allowFailure: true,
    });
    const inspection = await docker(["inspect", "--format", "{{json .State}}", name]);
    const state = JSON.parse(inspection.stdout);
    report.container = {
      name,
      exitCode: state.ExitCode,
      status: state.Status,
      oomKilled: state.OOMKilled,
    };
    if (attached.code !== 0 || state.Status !== "exited" || state.ExitCode !== 0) {
      throw new Error(
        `Chrome E2E failed: container exit ${state.ExitCode}; see browser/report.json and commands.log.`,
      );
    }
    return report.container;
  });
}

async function finish() {
  cleaning = true;
  if (mainContainerCreated) {
    await cleanupStep("Save browser reports and screenshots", async () => {
      const directory = join(output, "browser");
      await mkdir(directory, { recursive: true });
      await docker(["cp", `${name}:/artifacts/.`, directory], { cleanup: true });
      report.browserReport = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
      if (report.status === "passed" && report.browserReport.success !== true)
        throw new Error("The browser report does not confirm success.");
    });
  }
  if (containers.has(serverName)) {
    await cleanupStep("Save temporary server logs", async () => {
      const logs = await docker(["logs", serverName], { cleanup: true, allowFailure: true });
      await writeFile(join(output, "server.log"), redact(logs.stdout + logs.stderr));
    });
  }
  for (const container of [...containers].reverse())
    await cleanupStep(`Remove container ${container}`, () =>
      removeResource(["rm", "--force", container]),
    );
  for (const volume of volumes)
    await cleanupStep(`Remove volume ${volume}`, () => removeResource(["volume", "rm", volume]));
  if (startedVm && !options.keepVm)
    await cleanupStep("Stop the Colima VM started by this run", () =>
      command("colima", ["stop", profile], { cleanup: true }),
    );
  else
    report.cleanup.push({
      name: "Colima VM",
      status: "skipped",
      reason: options.keepVm ? "--keep-vm" : "Not started by this run",
    });
  if (ownsLock) await cleanupStep("Release runner lock", () => rm(lock, { recursive: true }));
  if (report.cleanup.some((entry) => entry.status === "failed") || signal) report.status = "failed";
  report.signal = signal;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  const screenshots = mainContainerCreated
    ? (await readdir(join(output, "browser")).catch(() => [])).filter((file) =>
        file.endsWith(".png"),
      )
    : [];
  const browserLinks = mainContainerCreated
    ? `<p><a href="browser/report.json">Browser report</a>${screenshots.map((file) => ` · <a href="browser/${escape(file)}">${escape(file)}</a>`).join("")}</p>`
    : "";
  const browserScenarios = report.browserReport
    ? `<h2>Browser scenarios</h2><ul>${(report.browserReport.steps ?? []).map((entry) => `<li>${entry.success ? "passed" : "failed"} — ${escape(entry.name)}</li>`).join("")}</ul>${report.browserReport.error ? `<p>Failed at ${escape(report.browserReport.error.phase)}: ${escape(report.browserReport.error.message)}</p>` : ""}`
    : "";
  await writeFile(
    join(output, "report.html"),
    `<!doctype html><meta charset="utf-8"><title>Chrome E2E ${escape(report.status)}</title><h1>Chrome ${escape(options.suite)} E2E: ${escape(report.status)}</h1><p>${escape(report.scope)}</p><p>Run: ${escape(runId)}</p><p><a href="report.json">JSON report</a> · <a href="commands.log">Command log</a></p><h2>Environment and E2E</h2><ul>${report.steps.map((entry) => `<li>${escape(entry.status)} — ${escape(entry.name)} ${escape(entry.error?.message)}</li>`).join("")}</ul>${browserScenarios}<h2>Cleanup</h2><ul>${report.cleanup.map((entry) => `<li>${escape(entry.status)} — ${escape(entry.name)} ${escape(entry.error?.message ?? entry.reason)}</li>`).join("")}</ul>${browserLinks}`,
  );
  await writeFile(
    join(repository, ".debug/chrome-e2e", options.setupOnly ? "latest-setup.json" : "latest.json"),
    JSON.stringify(
      {
        runId,
        status: report.status,
        report: join(output, "report.json"),
        html: join(output, "report.html"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${report.status.toUpperCase()}: ${join(output, "report.html")}`);
  process.exitCode =
    signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : report.status === "passed" ? 0 : 1;
}
