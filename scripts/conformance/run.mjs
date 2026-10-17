import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { files, hash, pins, readJSON } from "./common.mjs";
import {
  baselineEntry,
  compare,
  EngineWorker,
  expectation,
  hasGap,
  regression,
  score,
} from "./runner.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes("--help")) {
  console.log(
    "Conformance: [--check | --strict | --update-baseline] [--suite substring] [--filter substring] [--limit N] [--timeout-ms N] [--report path]\nDefault: write a report; differences are informational. --check gates against reviewed known gaps; --strict requires full parity.",
  );
  process.exit(0);
}
const allowed = new Set([
  "--check",
  "--strict",
  "--update-baseline",
  "--suite",
  "--filter",
  "--limit",
  "--timeout-ms",
  "--report",
  "--update-ruby-expectations",
]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (["--suite", "--filter", "--limit", "--timeout-ms", "--report"].includes(args[i])) {
    if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing option value");
  }
}
const timeoutMs = Number(value("--timeout-ms", "2000"));
const limit = Number(value("--limit", "1000000"));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(limit) || limit < 1)
  throw new Error("Limits must be positive integers");
if (
  args.includes("--update-baseline") &&
  args.some((a) => ["--suite", "--filter", "--limit"].includes(a))
)
  throw new Error("Baseline updates require the full corpus");
const installed = readJSON("node_modules/liquidjs/package.json");
if (installed.version !== pins.liquidjs.version)
  throw new Error("Installed LiquidJS version does not match the pinned corpus");
const all = files("conformance/fixtures")
  .filter((p) => p.endsWith(".json"))
  .flatMap(readJSON);
const seen = new Set();
for (const fixture of all) {
  if (!fixture.id || typeof fixture.source !== "string" || seen.has(fixture.id))
    throw new Error(`Invalid or duplicate fixture: ${fixture.id}`);
  if (!["ruby", "liquidjs"].includes(fixture.authority))
    throw new Error(`Missing authority: ${fixture.id}`);
  seen.add(fixture.id);
}
const selected = all
  .filter(
    (f) =>
      (f.origin?.repository ?? "local").includes(value("--suite", "")) &&
      f.id.includes(value("--filter", "")),
  )
  .slice(0, limit);
if (!selected.length) throw new Error("No matching conformance fixtures");
const baselinePath = "conformance/baseline.json";
const baseline = existsSync(baselinePath) ? readJSON(baselinePath).cases : {};
const updating = args.includes("--update-baseline");
const nextBaseline = {};
const leftWorker = new EngineWorker("liquidjs", { timeoutMs });
const rightWorker = new EngineWorker("effect-liquid", { timeoutMs });
const rubyWorker = new EngineWorker("ruby", { timeoutMs });
const oracleExpectations = {};
const recordedRuby = existsSync("conformance/ruby-expectations.json")
  ? readJSON("conformance/ruby-expectations.json").cases
  : {};
const results = [];
const counts = {};
const perSuite = {};
const perDialect = {};
const gates = {};
const reportPath = value("--report", "conformance/reports/latest.json");
const fatal = [];
try {
  for (const fixture of selected) {
    const [left, right, ruby] = await Promise.all([
      leftWorker.run(fixture),
      rightWorker.run(fixture),
      rubyWorker.run(fixture),
    ]);
    if (!fixture.expected && ["output", "error", "parsed"].includes(ruby.kind))
      oracleExpectations[fixture.id] = {
        fixtureHash: hash(fixture),
        expected:
          ruby.kind === "output"
            ? ruby.truncated
              ? { kind: "output", sha256: ruby.sha256 }
              : { kind: "output", output: ruby.output }
            : ruby.kind === "parsed"
              ? { kind: "parsed" }
              : { kind: "error", phase: ruby.phase },
      };
    if (!fixture.expected && ruby.kind === "unsupported-configuration")
      oracleExpectations[fixture.id] = {
        fixtureHash: hash(fixture),
        unsupported: ruby.options,
        reason: "LiquidJS-specific execution option has no Ruby counterpart",
      };
    const supplemental = recordedRuby[fixture.id];
    const rubySupplementalExpectation = !supplemental
      ? "not-specified"
      : supplemental.fixtureHash !== hash(fixture)
        ? "stale-fixture"
        : supplemental.unsupported
          ? "unsupported-configuration"
          : expectation(ruby, supplemental.expected);
    const comparison = compare(left, right);
    const authorityScore = score(fixture, left, right);
    const dialect = (perDialect[fixture.authority] ??= {
      total: 0,
      pass: 0,
      fail: 0,
      unspecified: 0,
    });
    dialect.total++;
    dialect[
      authorityScore === "match"
        ? "pass"
        : authorityScore === "not-specified"
          ? "unspecified"
          : "fail"
    ]++;
    const gate = regression(fixture, left, right, baseline);
    const suite = fixture.origin?.repository ?? "local";
    counts[comparison] = (counts[comparison] ?? 0) + 1;
    perSuite[suite] ??= {};
    perSuite[suite][comparison] = (perSuite[suite][comparison] ?? 0) + 1;
    gates[gate] = (gates[gate] ?? 0) + 1;
    if (hasGap(fixture, left, right))
      nextBaseline[fixture.id] = baselineEntry(fixture, left, right);
    if (
      [left, right, ruby].some((r) => ["worker-error", "worker-crash", "timeout"].includes(r.kind))
    )
      fatal.push(fixture.id);
    results.push({
      id: fixture.id,
      authority: fixture.authority,
      authorityScore,
      origin: fixture.origin,
      source: fixture.source,
      comparison,
      regression: gate,
      upstreamExpectation: {
        liquidjs: expectation(left, fixture.expected),
        effectLiquid: expectation(right, fixture.expected),
      },
      rubySupplementalExpectation,
      ruby,
      rubyRecordedExpectation:
        fixture.authority === "ruby" ? expectation(ruby, fixture.expected) : "not-applicable",
      liquidjs: left,
      effectLiquid: right,
    });
    if (results.length % 250 === 0)
      console.log(`${results.length}/${selected.length}: ${counts.mismatch ?? 0} differences`);
  }
} finally {
  leftWorker.close();
  rightWorker.close();
  rubyWorker.close();
}
const stale =
  !args.includes("--suite") && !args.includes("--filter") && !args.includes("--limit")
    ? Object.keys(baseline).filter((id) => !seen.has(id))
    : [];
const summary = {
  total: selected.length,
  totalAvailable: all.length,
  rubyRecorded: {
    match: results.filter((r) => r.rubyRecordedExpectation === "match").length,
    different: results.filter((r) => r.rubyRecordedExpectation === "different").length,
  },
  rubyFilledUnspecified: Object.values(oracleExpectations).filter((x) => x.expected).length,
  rubyUnspecifiedUnsupported: Object.values(oracleExpectations).filter((x) => x.unsupported).length,
  rubySupplemental: {
    match: results.filter((r) => r.rubySupplementalExpectation === "match").length,
    different: results.filter((r) => r.rubySupplementalExpectation === "different").length,
    stale: results.filter((r) => r.rubySupplementalExpectation === "stale-fixture").length,
  },
  counts,
  perSuite,
  perDialect,
  authority: {
    pass: Object.values(perDialect).reduce((n, d) => n + d.pass, 0),
    fail: Object.values(perDialect).reduce((n, d) => n + d.fail, 0),
    unspecified: Object.values(perDialect).reduce((n, d) => n + d.unspecified, 0),
  },
  gates,
  workerFailures: fatal.length,
  staleBaselineCases: stale,
  upstreamExpectedDifferences: {
    liquidjs: results.filter((r) => r.upstreamExpectation.liquidjs === "different").length,
    effectLiquid: results.filter((r) => r.upstreamExpectation.effectLiquid === "different").length,
  },
};
const report = {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  engines: {
    ruby: pins["shopify-liquid"],
    liquidjs: installed.version,
    effectLiquid: readJSON("package.json").version,
  },
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    timezone: "UTC",
  },
  pins,
  corpusHash: hash(selected),
  summary,
  results,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const markdown = [
  "# Conformance report",
  "",
  `Cases: ${summary.total} of ${summary.totalAvailable}. This is a compatibility report, not a full-parity claim.`,
  "",
  "| Authority dialect | Pass | Fail | Unspecified | Total |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...Object.entries(perDialect).map(
    ([name, d]) => `| ${name} | ${d.pass} | ${d.fail} | ${d.unspecified} | ${d.total} |`,
  ),
  "",
  "Cross-engine agreement (informational):",
  "",
  "| Suite | Same output | Both parse | Same error category/phase | Different |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...Object.entries(perSuite).map(
    ([name, c]) =>
      `| ${name} | ${c["match-output"] ?? 0} | ${c["match-parse"] ?? 0} | ${c["match-error"] ?? 0} | ${c.mismatch ?? 0} |`,
  ),
  "",
  `Worker failures/timeouts: ${fatal.length}. Upstream expected results differ from LiquidJS in ${summary.upstreamExpectedDifferences.liquidjs} cases and effect-liquid in ${summary.upstreamExpectedDifferences.effectLiquid} cases. Ruby expectations use their original dialect; inspect each fixture's upstream options.`,
  "",
  "## Differences",
  "",
  ...results
    .filter((r) => r.comparison === "mismatch")
    .map(
      (r) =>
        `- [${r.id}](${r.origin?.url ?? "#"}): LiquidJS ${r.liquidjs.kind}; effect-liquid ${r.effectLiquid.kind}. ${r.effectLiquid.message ?? ""}`,
    ),
];
writeFileSync(reportPath.replace(/\.json$/, "") + ".md", `${markdown.join("\n")}\n`);
if (updating) {
  if (fatal.length)
    throw new Error(
      "Baseline not updated: worker failures/timeouts must be resolved or explicitly excluded first",
    );
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ schemaVersion: 2, pins, cases: nextBaseline }, null, 2)}\n`,
  );
}
if (args.includes("--update-ruby-expectations")) {
  if (fatal.length || selected.length !== all.length)
    throw new Error("Ruby expectation updates require a complete successful run");
  writeFileSync(
    "conformance/ruby-expectations.json",
    JSON.stringify({ pins, cases: oracleExpectations }, null, 2) + "\n",
  );
}
console.log(JSON.stringify(summary, null, 2));
console.log(`Report: ${reportPath}`);
if (
  fatal.length ||
  (args.includes("--strict") && Object.keys(nextBaseline).length) ||
  (args.includes("--check") &&
    (gates["new-gap"] ?? 0) + (gates["changed-gap"] ?? 0) + (gates.improved ?? 0) + stale.length >
      0)
)
  process.exitCode = 1;
