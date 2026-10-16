# Conformance corpus

Run `pnpm conformance` to score every executable fixture against its declared authority dialect. `liquidjs` cases use the live LiquidJS 10.29.0 result; `ruby` cases use their upstream expectation. Cross-engine comparison remains informational. Results are written to ignored `conformance/reports/latest.json` and `.md`. No timing measurements are collected.

- `pnpm conformance:check` fails on new or changed gaps, resolved gaps awaiting baseline removal, stale baseline cases, and worker failures.
- `pnpm conformance:strict` requires every authority score to pass (unspecified expectations do not count as passes).
- `pnpm conformance --suite liquidjs --filter expression` selects cases by repository and fixture ID substring.
- `pnpm conformance:baseline` records the current full-corpus gaps. Inspect the report before committing an updated baseline; this command is not a correctness fix.

The baseline gates authority failures, including unspecified expectations. Reports include pass/fail/unspecified counts per dialect and overall; unspecified cases remain in the denominator. A passing regression gate does **not** mean full Liquid compatibility. Output is compared exactly by a hash of the complete UTF-16 string, including whitespace. Ruby error expectations assert failure and phase where specified; LiquidJS errors compare normalized category and phase. Original messages remain in the report. Worker failures cannot be baselined.

Phase 1 changes measurement and fixture fidelity only: the jump from 4,688/6,296 under the old dual-agreement score to 5,649/6,298 under authority scoring is **not an engine improvement**. Contradictory LiquidJS/Ruby outcomes no longer make passing impossible. Ruby parser-error expectations are scored against Ruby, even when LiquidJS accepts the malformed syntax.

Both engines run in separate processes with in-memory template files, UTC, a per-case timeout, and a memory limit. A crash or timeout is an infrastructure failure and cannot be accepted into the baseline. Unsupported effect-liquid options are explicit results. The harness runs JavaScript engines only; Ruby supplies expected fixtures, not a third live execution engine.

## Sources and refresh

`upstreams.json` pins harttle/liquidjs, deepin-community/ruby-liquid, Shopify/liquid, and Shopify/liquid-spec. The latter is Shopify's portable YAML specification corpus. The LiquidJS npm oracle and source pin use the same release.

```sh
pnpm conformance:fetch
pnpm conformance:import
pnpm conformance
```

Importing requires Ruby with Ripper as well as Node dependencies; running checked-in fixtures does not require Ruby or upstream checkouts. Fetches go into ignored `.cache/upstream`. Importers inspect TypeScript/Ruby syntax and YAML data without executing upstream test code. Imported fixtures contain pinned source URLs, source line numbers, contexts, separate globals, options, and expectations when recoverable. See [NOTICE.md](NOTICE.md) for attribution.

`import-inventory.json` lists scanned source files with hashes and every recognized candidate's disposition. Static inputs use JSON plus an explicit Ruby value encoding. Custom Drops, functions, generated data, filesystem mocks, unsupported syntax/options, and other setup that cannot be faithfully translated have exclusion reasons. Standalone templates and documentation snippets without complete inputs/expected output are catalogued with their text, rather than assigned invented inputs. This is a broad static import, not a claim that every upstream test is executable or discovered.

Ruby strict/strict2 parsing and host semantics can differ from LiquidJS. Original dialect options are retained as metadata; differences against those expectations remain visible and gated. Extending adapters should include an importer regression test so an extraction error cannot masquerade as an engine bug.

## Add a case

Add an object to `fixtures/local.json` with an explicit `authority: "ruby" | "liquidjs"`, a unique stable `id`, `source`, JSON `context`, `options`, `operation` (`render` or `parse`), and `origin.repository: "local"`. Optional `templates` maps names to source strings. An output expectation is `{"kind":"output","output":"exact text"}`; an error expectation is `{"kind":"error","phase":"parse"}` (phase may be omitted).

Run the selected case, inspect both results, and then run the full regression gate. Keep upstream-imported JSON generated; changes to extraction belong in the importers. Deliberate unsupported cases belong in the inventory or the explicit baseline, never in a silent skip list.

## Fixture value encoding

`context` contains assigns; `globals` contains the static environment visible to isolated renders. Shopify helper assigns and liquid-spec environments populate `globals`. Stub-file-system partials populate `templates`, never context.

Ruby values use a singleton object `{ "$liquid": { "type": "float", "value": "0.0" } }`. Numeric types are `integer`, `float`, and `decimal`, with decimal strings preserving precision and numeric kind; `symbol` carries a string `value`. `range` carries encoded `from`, `to`, and boolean `exclusive`. `hash` carries `entries` of encoded key/value pairs, preserving symbol keys. Plain string-key hashes remain JSON records. This reserved encoding is interpreted only in fixture value channels. The LiquidJS adapter projects tags to JavaScript values; the Ruby adapter passes them to the Ruby value model. Importer `instantiate:` descriptors are explicitly excluded because they require host classes/callbacks.

Importers inspect source without evaluating upstream tests. Regression tests cover partial keywords, positional contexts, static environments, numeric kinds, symbols, and ranges. Ruby extraction tests run when Ruby is installed; checked-in fixtures need only Node.
