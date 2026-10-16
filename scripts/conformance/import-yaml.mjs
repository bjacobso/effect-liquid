import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAlias, isMap, isSeq, isScalar, LineCounter, parseAllDocuments } from "yaml";
import { id, origin } from "./common.mjs";

export function encodeYaml(node, doc) {
  if (!node) return {};
  if (isAlias(node)) return encodeYaml(node.resolve(doc), doc);
  if (isScalar(node)) {
    if (typeof node.value === "number")
      return {
        $liquid: {
          type: /[.eE]/.test(node.source) ? "float" : "integer",
          value: String(node.source),
        },
      };
    return node.value;
  }
  if (isSeq(node)) return node.items.map((n) => (n === null ? null : encodeYaml(n, doc)));
  if (isMap(node))
    return Object.fromEntries(
      node.items.map((p) => [
        String(p.key.value),
        p.value === null ? null : encodeYaml(p.value, doc),
      ]),
    );
  throw new Error("Unsupported YAML value");
}

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
export function yamlCases(text, path, root, inventory = []) {
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
        const globals = encodeYaml(node.get("environment", true), doc) ?? {};
        const context = {};
        const templates = s.filesystem ?? {};
        if (Array.isArray(globals) || typeof globals !== "object" || globals === null)
          throw new Error("Non-record context");
        if (Object.values(templates).some((t) => typeof t !== "string"))
          throw new Error("Non-string filesystem entry");
        result.push({
          ...base,
          source: s.template,
          context,
          globals,
          authority: "ruby",
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
