import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { yamlCases } from "./import-yaml.mjs";
import { files, hash, id, origin, pins } from "./common.mjs";
import { extractTypeScript } from "./import-typescript.mjs";

const inventory = [];
const sourceFiles = [];
const corpus = {};
for (const [repo, pin] of Object.entries(pins)) {
  const root = `.cache/upstream/${repo}`;
  if (!existsSync(root)) throw new Error(`Run pnpm conformance:fetch first: missing ${repo}`);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== pin.commit) throw new Error(`Wrong upstream revision for ${repo}`);
  const all = files(root);
  const fixtures = [];
  const scanned = all.filter((file) => {
    const path = relative(root, file);
    return repo === "liquid-spec"
      ? path.startsWith("specs/") && path.endsWith(".yml")
      : (/^(test|docs|demo|example|performance|benchmark)\//.test(path) &&
          /\.(ts|rb|md|liquid|html)$/.test(path)) ||
          path === "README.md";
  });
  for (const file of scanned)
    sourceFiles.push({
      repository: repo,
      path: relative(root, file),
      sha256: hash(readFileSync(file)),
    });
  if (repo === "liquidjs")
    for (const file of scanned.filter((p) => p.includes("/test/") && p.endsWith(".ts"))) {
      const extracted = extractTypeScript(readFileSync(file, "utf8"), relative(root, file));
      fixtures.push(...extracted.fixtures);
      inventory.push(...extracted.inventory);
    }
  if (repo === "ruby-liquid" || repo === "shopify-liquid") {
    const ruby = scanned
      .filter((p) => p.includes("/test/") && p.endsWith(".rb"))
      .map((absolute) => ({
        absolute: resolve(absolute),
        path: relative(root, absolute),
        repository: repo,
      }));
    const extracted = JSON.parse(
      execFileSync("ruby", ["scripts/conformance/import-ruby.rb"], {
        input: JSON.stringify(ruby),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      }),
    );
    for (const { path, result } of extracted) {
      for (const f of result.fixtures) {
        const { line, column, call: _call, ...data } = f;
        fixtures.push({
          ...data,
          id: id(repo, path, line, column),
          origin: origin(repo, path, line),
          suite: "upstream-test",
          authority: "ruby",
          options: { strictFilters: false },
        });
      }
      for (const item of result.inventory)
        inventory.push({
          ...item,
          id: id(repo, path, item.line, item.column),
          origin: origin(repo, path, item.line),
        });
    }
  }
  if (repo === "liquid-spec")
    for (const file of scanned.filter((p) => !p.endsWith("/suite.yml")))
      fixtures.push(
        ...yamlCases(readFileSync(file, "utf8"), relative(root, file), root, inventory),
      );
  // Preserve all standalone templates and Liquid markdown fences as catalogue entries.
  // Documentation often omits context or normalizes whitespace: these are not fabricated tests.
  for (const file of scanned) {
    const path = relative(root, file);
    const text = readFileSync(file, "utf8");
    if (/\.(liquid|html)$/.test(file) && /\{[{%]/.test(text))
      inventory.push({
        id: id(repo, path, 1),
        origin: origin(repo, path, 1),
        status: "catalogued",
        reason: "Standalone template requires application context/partials",
        source: text,
      });
    if (file.endsWith(".md")) {
      const pattern = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1\s*$/gm;
      for (const match of text.matchAll(pattern)) {
        if (!/\{[{%]/.test(match[3])) continue;
        const line = text.slice(0, match.index).split("\n").length;
        inventory.push({
          id: id(repo, path, line),
          origin: origin(repo, path, line),
          status: "catalogued",
          reason: "Documentation example requires explicit context and whitespace expectations",
          source: match[3],
        });
      }
    }
  }
  for (let index = fixtures.length - 1; index >= 0; index--) {
    const fixture = fixtures[index];
    if (/['"](?:now|today)['"]\s*\|\s*date|\|\s*sample\b/.test(fixture.source)) {
      const entry = inventory.find((entry) => entry.id === fixture.id);
      if (entry) {
        entry.status = "excluded";
        entry.reason = "Requires a shared fixed clock or random-source adapter";
      }
      fixtures.splice(index, 1);
    }
  }
  for (const f of fixtures) f.authority = repo === "liquidjs" ? "liquidjs" : "ruby";
  corpus[repo] = fixtures.sort((a, b) => a.id.localeCompare(b.id));
  process.stdout.write(`${repo}: ${fixtures.length} executable fixtures\n`);
}
mkdirSync("conformance/fixtures", { recursive: true });
for (const [repo, fixtures] of Object.entries(corpus))
  writeFileSync(`conformance/fixtures/${repo}.json`, JSON.stringify(fixtures, null, 2) + "\n");
const counts = {};
for (const entry of inventory) {
  const key = `${entry.origin.repository}:${entry.status}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
writeFileSync(
  "conformance/import-inventory.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      pins,
      sourceFiles,
      counts,
      entries: inventory.sort((a, b) => a.id.localeCompare(b.id)),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
