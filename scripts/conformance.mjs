import { writeFileSync } from "node:fs";
import { Liquid } from "liquidjs";
import { registry } from "../dist/Builtins.js";

const reference = new Liquid();
const tags = new Set([
  "assign",
  "layout",
  "block",
  "liquid",
  "tablerow",
  "#",
  "increment",
  "decrement",
  "cycle",
  "for",
  "capture",
  "case",
  "comment",
  "include",
  "render",
  "if",
  "raw",
  "unless",
  "break",
  "continue",
  "echo",
]);
const implementedOptions = new Set([
  "strictVariables",
  "strictFilters",
  "globals",
  "ownPropertyOnly",
  "groupedExpressions",
  "trimTagLeft",
  "trimTagRight",
  "trimOutputLeft",
  "trimOutputRight",
  "greedy",
  "jekyllWhere",
  "lenientIf",
  "outputEscape",
  "tagDelimiterLeft",
  "tagDelimiterRight",
  "outputDelimiterLeft",
  "outputDelimiterRight",
]);
const inventory = (names, implemented) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      {
        status: implemented.has(name) ? "partial" : "deferred",
        ...(implemented.has(name)
          ? {
              tests: [
                "test/conformance.test.ts",
                "test/engine.test.ts",
                "test/compatibility-expansion.test.ts",
                "test/blocks.test.ts",
                "test/partial-bindings.test.ts",
                "test/string-filters.test.ts",
                "test/url-filters.test.ts",
                "test/expression-filters.test.ts",
                "test/numeric-filters.test.ts",
                "test/base64-filters.test.ts",
                "test/grouped-expressions.test.ts",
                "test/property-lookup.test.ts",
                "test/sentence-filters.test.ts",
                "test/whitespace-options.test.ts",
                "test/date-filters.test.ts",
                "test/collection-gaps.test.ts",
                "test/render-options.test.ts",
                "test/interpolated-partials.test.ts",
                "test/layout.test.ts",
                "test/parser-compat.test.ts",
              ],
            }
          : {}),
      },
    ]),
  );
const manifest = {
  baseline: {
    package: "liquidjs",
    version: "10.29.0",
    commit: "747bdbdbee171c7bab56c597a34f6fa5925b4a58",
    options: {
      strictFilters: true,
      strictVariables: false,
      jsTruthy: false,
      ownPropertyOnly: true,
    },
    runtime: "Node.js 24.13.0",
    effect: "3.22.2",
    source: "https://github.com/harttle/liquidjs/tree/747bdbdbee171c7bab56c597a34f6fa5925b4a58",
  },
  provenance:
    "Production implementation is independent. Development conformance includes original cases and statically imported upstream fixtures. See conformance/upstreams.json, import-inventory.json, and NOTICE.md for pinned provenance, exclusions, and retained licenses.",
  statusMeaning: {
    partial: "Implemented for the documented subset, with tests; complete parity is not claimed.",
    deferred:
      "Not implemented; unsupported syntax is rejected. Options absent from our API are not accepted as configuration.",
  },
  tags: inventory(Object.keys(reference.tags), tags),
  filters: inventory(Object.keys(reference.filters), new Set(registry.filters.keys())),
  options: inventory(Object.keys(reference.options), implementedOptions),
  syntax: {
    identifiers: "ASCII letter/underscore followed by word characters or hyphens",
    lookups:
      "Variable-rooted and bare context bracket access; computed lookup indices; sequence length/size and record size fallback; literal receiver indexing deferred",
    expressions:
      "Literals, ranges, comparisons, contains, not, right-associated and/or, filter pipelines; opt-in parenthesized conditions and pipelines",
    partials:
      "Literal or variable template names, interpolated quoted filenames, with/for/as bindings, and comma-separated named arguments.",
    loops: "limit, numeric offset, reversed, else, and offset:continue",
  },
  hostValues: {
    plainRecords: "supported with own data properties only",
    arrays: "supported, including nil-normalized holes",
    getters: "rejected without invocation",
    classInstances: "rejected",
    nonFiniteNumbers: "rejected, including non-finite filter results",
    prototypeKeys: "excluded from context normalization",
  },
  differences: [
    {
      feature: "strictFilters",
      behavior:
        "Defaults true; unknown filter failures occur during rendering rather than parsing.",
    },
    {
      feature: "raw trim delimiters",
      behavior: "Accepts trimmed endraw delimiters that the pinned oracle rejects.",
      tests: ["test/conformance.test.ts"],
    },
    {
      feature: "resource limits",
      behavior:
        "Finite limits with typed errors and cancellation checkpoints; units/defaults are independent of LiquidJS.",
    },
    {
      feature: "duplicate named arguments",
      behavior: "Rejected rather than silently overwriting an earlier expression.",
    },
    {
      feature: "sentence filter non-array inputs",
      behavior:
        "Rejects non-arrays, including short strings and array-like records accepted by the pinned oracle.",
      tests: ["test/sentence-filters.test.ts"],
    },
    {
      feature: "numeric non-finite results",
      behavior: "Rejected by the finite Liquid value boundary instead of printing Infinity/NaN.",
    },
  ],
  api: {
    parse: "implemented",
    render: "implemented",
    renderStream: "implemented as Effect Stream",
    analyze: "implemented with explicit conservative-flow coverage",
    analyzeProject: "implemented for bounded render dependencies; include summaries are partial",
    check: "experimental gradual checker",
    checkProject: "experimental render-contract checking",
    schema: "decoded structural projection; recursive/opaque shapes are partial",
    customFilters: "Effect registry preserves typed errors and service requirements",
    customTags: "deferred",
    cache: "deferred",
    dropInLiquidClass: "out of scope",
    syncPromiseFacades: "out of scope",
    browser: "core bundle verified; no Node adapters imported by parser",
    cli: "local parse/analyze/render/check; filesystem project CLI deferred",
  },
};
writeFileSync("CONFORMANCE.json", `${JSON.stringify(manifest, null, 2)}\n`);
