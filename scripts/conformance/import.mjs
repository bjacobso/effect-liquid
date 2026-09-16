import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isMap, isSeq, LineCounter, parseAllDocuments } from "yaml";
import { files, hash, id, origin, pins } from "./common.mjs";
import { extractTypeScript } from "./import-typescript.mjs";

const inventory = [];
const sourceFiles = [];
const corpus = {};
function jsonValue(v, seen = new Set()) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (!v || typeof v !== "object") throw new Error("Non-JSON value");
  if (seen.has(v)) throw new Error("Cyclic YAML/host value");
  seen.add(v);
  let result;
  if (v instanceof Map) {
    result = {};
    for (const [k, value] of v) {
      if (typeof k !== "string") throw new Error("Non-string YAML mapping key");
      Object.defineProperty(result, k, { value: jsonValue(value, seen), enumerable: true });
    }
  } else if (Array.isArray(v)) result = v.map((x) => jsonValue(x, seen));
  else {
    result = {};
    for (const [k, value] of Object.entries(v))
      Object.defineProperty(result, k, { value: jsonValue(value, seen), enumerable: true });
  }
  seen.delete(v);
  return result;
}
function unsupportedOptions(s) {
  if (s.generate) return "Generated fixture requires the upstream generator";
  if (s.context_klass || s.exception_renderer)
    return "Custom Ruby context/exception renderer required";
  if (s.resource_limits) return "Ruby resource-limit semantics require an adapter";
  if (s.render_errors === true && !s.errors?.parse_error)
    return "Inline rendered-error semantics require an adapter";
  if (s.error_mode && !["strict", "strict2"].includes(String(s.error_mode).replace(/^:/, "")))
    return `Ruby parser mode requires an adapter: ${s.error_mode}`;
  if (s.features?.some((f) => /drop|active.?support|ruby_object/.test(f)))
    return `Custom host values required: ${s.features.join(", ")}`;
  return undefined;
}
function yamlCases(text, path, root) {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter, uniqueKeys: false, logLevel: "silent" });
  const result = [];
  const suitePath = `${dirname(root + "/" + path)}/suite.yml`;
  let defaults = {};
  if (existsSync(suitePath)) {
    const d = parseAllDocuments(readFileSync(suitePath, "utf8"), { logLevel: "silent" })[0]?.toJS();
    defaults = d?.defaults ?? {};
  }
  for (const doc of docs) {
    const seq = isSeq(doc.contents)
      ? doc.contents
      : isMap(doc.contents)
        ? doc.contents.get("specs", true)
        : undefined;
    if (!isSeq(seq)) continue;
    for (const node of seq.items) {
      const line = lineCounter.linePos(node?.range?.[0] ?? 0).line;
      const base = { id: id("liquid-spec", path, line), origin: origin("liquid-spec", path, line) };
      try {
        const warnings = [...doc.errors, ...doc.warnings].filter(
          (e) => e.pos?.[0] >= (node.range?.[0] ?? 0) && e.pos?.[0] < (node.range?.[1] ?? Infinity),
        );
        if (warnings.length)
          throw new Error(`Unsupported YAML: ${warnings[0].message.split("\n")[0]}`);
        // Conversion uses the complete document for aliases, then selects this entry.
        // Map keys stay typed until validation; numeric/Ruby keys are never silently stringified.
        const raw = jsonValue(node.toJS(doc, { mapAsMap: true, maxAliasCount: 1000 }));
        const s = { ...defaults, ...raw };
        const reason = unsupportedOptions(s);
        if (reason) throw new Error(reason);
        if (typeof s.template !== "string") throw new Error("Missing literal template");
        if (s.expected_pattern)
          throw new Error("Ruby expected_pattern needs regex dialect translation");
        let expected;
        if (s.errors) {
          if (s.errors.parse_error) expected = { kind: "error", phase: "parse" };
          else if (s.errors.render_error) expected = { kind: "error", phase: "render" };
          else throw new Error("Unsupported upstream error assertion");
        } else if (typeof s.expected === "string")
          expected = { kind: "output", output: s.expected };
        else throw new Error("Missing exact expected output");
        const context = s.environment ?? {};
        const templates = s.filesystem ?? {};
        if (Array.isArray(context) || typeof context !== "object" || context === null)
          throw new Error("Non-record context");
        if (Object.values(templates).some((t) => typeof t !== "string"))
          throw new Error("Non-string filesystem entry");
        result.push({
          ...base,
          source: s.template,
          context,
          templates,
          options: { strictFilters: false },
          operation: expected.phase === "parse" ? "parse" : "render",
          expected,
          suite: "liquid-spec",
          name: s.name,
          features: s.features ?? [],
          complexity: s.complexity ?? null,
          upstreamOptions: {
            errorMode: s.error_mode ?? "strict",
            renderErrors: s.render_errors ?? false,
          },
        });
        inventory.push({ ...base, status: "imported", name: s.name });
      } catch (error) {
        inventory.push({ ...base, status: "excluded", reason: error.message });
      }
    }
  }
  return result;
}
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
      ? path.startsWith("specs/") && /\.yml$/.test(path)
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
      .map((absolute) => ({ absolute: resolve(absolute), path: relative(root, absolute) }));
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
        const { line, column, call, ...data } = f;
        fixtures.push({
          ...data,
          id: id(repo, path, line, column),
          origin: origin(repo, path, line),
          suite: "upstream-test",
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
      fixtures.push(...yamlCases(readFileSync(file, "utf8"), relative(root, file), root));
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
