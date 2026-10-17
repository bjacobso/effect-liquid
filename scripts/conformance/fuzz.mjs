import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hash, readJSON } from "./common.mjs";
import { generate } from "./generate.mjs";
import { compare, EngineWorker, expectation } from "./runner.mjs";
const args = process.argv.slice(2),
  value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const seed = Number(value("--seed", 42)),
  count = Number(value("--cases", 100));
if (
  !Number.isInteger(seed) ||
  seed < 0 ||
  seed > 0xffffffff ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 1000
)
  throw new Error("Seed must be uint32; cases must be 1..1000 per dialect");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--record") continue;
  if (!["--seed", "--cases"].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  i++;
}
const right = new EngineWorker("effect-liquid"),
  js = new EngineWorker("liquidjs"),
  ruby = new EngineWorker("ruby");
const failures = [];
try {
  for (const dialect of ["liquidjs", "ruby"])
    for (const fixture of generate(seed, count, dialect)) {
      const [oracle, actual] = await Promise.all([
        (dialect === "ruby" ? ruby : js).run(fixture),
        right.run(fixture),
      ]);
      if (
        [oracle, actual].some((r) => ["worker-error", "worker-crash", "timeout"].includes(r.kind))
      )
        throw new Error(
          `Oracle infrastructure failure: ${JSON.stringify({ fixture, oracle, actual })}`,
        );
      const expected =
        oracle.kind === "output"
          ? { kind: "output", output: oracle.output }
          : oracle.kind === "error"
            ? { kind: "error", phase: oracle.phase }
            : { kind: "parsed" };
      const match =
        dialect === "ruby"
          ? expectation(actual, expected) === "match"
          : compare(oracle, actual) !== "mismatch";
      if (!match)
        failures.push({
          fixture: {
            ...fixture,
            id: `generated:${dialect}:${hash({ source: fixture.source, context: fixture.context }).slice(0, 16)}`,
            expected,
          },
          oracle,
          actual,
        });
    }
} finally {
  right.close();
  js.close();
  ruby.close();
}
mkdirSync("conformance/reports", { recursive: true });
writeFileSync(
  `conformance/reports/fuzz-${seed}.json`,
  JSON.stringify({ seed, casesPerDialect: count, failures }, null, 2) + "\n",
);
if (args.includes("--record") && failures.length) {
  const path = "conformance/fixtures/generated.json",
    existing = existsSync(path) ? readJSON(path) : [];
  writeFileSync(
    path,
    JSON.stringify(
      [...new Map([...existing, ...failures.map((x) => x.fixture)].map((f) => [f.id, f])).values()],
      null,
      2,
    ) + "\n",
  );
}
console.log(
  JSON.stringify(
    {
      seed,
      generated: count * 2,
      differences: failures.length,
      report: `conformance/reports/fuzz-${seed}.json`,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
