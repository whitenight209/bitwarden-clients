import { appendFile, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const text = (value) =>
  String(value ?? "")
    .replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    )
    .replace(/[\\`|\[\]*_]/g, "\\$&")
    .replace(/[\r\n]+/g, " ");

function status(value, success) {
  if (["skipped", "pending", "interrupted", "running"].includes(value)) return "SKIPPED";
  if (success === false || ["failed", "unexpected", "timedOut"].includes(value)) return "FAIL";
  if (success === true || ["passed", "expected", "flaky"].includes(value)) return "PASS";
  return "UNKNOWN";
}

function variant(report) {
  if (report.passkeyPanel || report.browserReport?.variant === "passkey-panel")
    return "passkey-panel";
  if (report.preopenPanel || report.browserReport?.variant === "preopened-locked-panel")
    return "preopened-locked-panel";
  if (report.suite === "authenticated") return "closed-panel";
  return report.suite ?? report.browserReport?.suite ?? "unknown";
}

function duration(report) {
  const elapsed = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? `${(elapsed / 1000).toFixed(1)}s` : "—";
}

function link(label, url) {
  try {
    const parsed = new URL(url);
    if (["https:", "http:"].includes(parsed.protocol)) return `[${label}](<${parsed.href}>)`;
  } catch {
    // A failed artifact upload can leave its output URL empty.
  }
  return "Artifact unavailable";
}

/** Read only the runner reports; each embeds its browser report and cleanup outcome. */
export async function readReports(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const reports = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name === "active.lock") continue;
    try {
      const report = JSON.parse(await readFile(join(directory, entry.name, "report.json"), "utf8"));
      if (!report || typeof report !== "object" || Array.isArray(report))
        throw new Error("Invalid runner report");
      reports.push({ directory: entry.name, report });
    } catch (error) {
      if (error.code === "ENOENT") {
        reports.push({
          directory: entry.name,
          issue: "Runner report missing; execution may have stopped before cleanup.",
        });
      } else {
        reports.push({ directory: entry.name, issue: "Runner report could not be parsed." });
      }
    }
  }
  return reports;
}

function rows(entries, browser = false) {
  return (Array.isArray(entries) ? entries : []).map((value) => {
    const entry = value ?? {};
    return {
      name: entry.file
        ? `${entry.file}: ${entry.name ?? "Unnamed case"}`
        : (entry.name ?? "Unnamed case"),
      result: status(entry.status, browser ? entry.success : undefined),
      note:
        entry.error?.message ??
        entry.reason ??
        (typeof entry.error === "string"
          ? entry.error
          : entry.status === "flaky"
            ? "Passed after retry"
            : ""),
    };
  });
}

function runResult(report, cases, environment, cleanup) {
  if (
    report.status === "failed" ||
    report.browserReport?.success === false ||
    cases.some((entry) => entry.result === "FAIL") ||
    environment.some((entry) => entry.result === "FAIL") ||
    cleanup.some((entry) => entry.result === "FAIL")
  )
    return "FAIL";
  // A green infrastructure run alone cannot stand in for completed browser assertions.
  if (
    report.status === "passed" &&
    report.browserReport?.success === true &&
    cases.length > 0 &&
    cases.every((entry) => entry.result === "PASS")
  )
    return "PASS";
  return "INCOMPLETE";
}

function caseTable(title, entries) {
  if (!entries.length) return `**${title}:** no entries recorded.\n\n`;
  const selected = entries.slice(0, 2000);
  return (
    `**${title}**\n\n| Case | Result | Detail |\n|---|---|---|\n` +
    selected
      .map(
        (entry) =>
          `| ${text(entry.name)} | ${entry.result} | ${text(String(entry.note).slice(0, 300))} |`,
      )
      .join("\n") +
    (entries.length > selected.length
      ? `\n\n${entries.length - selected.length} more entries are in the HTML/JSON artifact.`
      : "") +
    "\n\n"
  );
}

/** Render cases inline because GitHub artifacts download HTML rather than hosting it. */
export function renderSummary(
  reports,
  { expected = [], artifactUrl, artifactName = "Chrome E2E reports" } = {},
) {
  const runs = reports.map((entry) => {
    const report = entry.report ?? {};
    const cases = rows(report.browserReport?.steps, true);
    if (
      report.browserReport?.success === false &&
      report.browserReport.error?.phase &&
      !cases.some((entry) => entry.result === "FAIL")
    ) {
      cases.push({
        name: `Failed phase: ${report.browserReport.error.phase}`,
        result: "FAIL",
        note: report.browserReport.error.message ?? "",
      });
    }
    const environment = rows(report.steps);
    const cleanup = rows(report.cleanup);
    return {
      ...entry,
      variant: variant(report),
      cases,
      environment,
      cleanup,
      result: entry.issue ? "INCOMPLETE" : runResult(report, cases, environment, cleanup),
    };
  });
  const missing = expected.filter((name) => !runs.some((run) => run.variant === name));
  const counts = Object.fromEntries(
    ["PASS", "FAIL", "INCOMPLETE"].map((result) => [
      result,
      runs.filter((run) => run.result === result).length,
    ]),
  );
  const artifact = link("Download HTML reports, JSON and screenshots", artifactUrl);
  let summary =
    `## Chrome E2E results\n\n${counts.PASS} passed · ${counts.FAIL} failed · ${counts.INCOMPLETE} incomplete · ${missing.length} not run\n\n` +
    `${artifact} — ${text(artifactName)}\n\n` +
    "Expand a run below to inspect its cases directly. To view its full HTML report, download the artifact and open the listed `report.html` file.\n\n" +
    "| Run | Variant | Result | Browser cases | Duration | HTML report in artifact |\n|---|---|---|---|---|---|\n";
  for (const run of runs) {
    const passed = run.cases.filter((entry) => entry.result === "PASS").length;
    summary += `| ${text(run.directory)} | ${text(run.variant)} | ${run.result} | ${passed}/${run.cases.length} passed | ${duration(run.report ?? {})} | ${text(run.directory)}/report.html |\n`;
  }
  for (const name of missing) summary += `| — | ${text(name)} | NOT RUN | — | — | — |\n`;
  if (!runs.length)
    summary += "\nNo runner reports were produced. Check the earlier build/setup/test steps.\n";
  summary += "\n";
  for (const run of runs) {
    const error = run.report?.browserReport?.error ?? run.report?.error;
    const failure =
      run.issue ??
      (error
        ? `${error.phase ? `${error.phase}: ` : ""}${error.message ?? "Run failed"}`
        : undefined);
    const detail =
      `<details>\n<summary>${run.result}: ${text(run.variant)} — ${text(run.directory)}</summary>\n\n` +
      `${artifact}\n\nHTML: \`${text(run.directory)}/report.html\` · Browser JSON: \`${text(run.directory)}/browser/report.json\`\n\n` +
      (failure ? `**Failure:** ${text(String(failure).slice(0, 1000))}\n\n` : "") +
      caseTable("Browser cases", run.cases) +
      caseTable("Environment and execution", run.environment) +
      caseTable("Cleanup", run.cleanup) +
      "</details>\n\n";
    if (Buffer.byteLength(summary + detail) > 900_000) {
      summary +=
        "Additional case details exceed the GitHub summary size limit; inspect the HTML/JSON artifact.\n";
      break;
    }
    summary += detail;
  }
  return summary;
}

async function main() {
  let directory = ".debug/chrome-e2e";
  const expected = [];
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--root" && process.argv[index + 1]) directory = process.argv[++index];
    else if (argument === "--expected" && process.argv[index + 1])
      expected.push(process.argv[++index]);
    else throw new Error("Usage: node summarize-reports.mjs [--root DIR] [--expected VARIANT]...");
  }
  const fallbackUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}#artifacts`
      : undefined;
  const summary = renderSummary(await readReports(resolve(directory)), {
    expected,
    artifactUrl: process.env.CHROME_E2E_ARTIFACT_URL || fallbackUrl,
    artifactName: process.env.CHROME_E2E_ARTIFACT_NAME,
  });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
