# Conformance corpus

Run `pnpm conformance` to score every executable fixture against its declared authority dialect. `liquidjs` cases use the live LiquidJS 10.29.0 result; `ruby` cases use their upstream expectation. Cross-engine comparison remains informational. Results are written to ignored `conformance/reports/latest.json` and `.md`. No timing measurements are collected.

- `pnpm conformance:check` fails on new or changed gaps, resolved gaps awaiting baseline removal, stale baseline cases, and worker failures.
- `pnpm conformance:strict` requires every authority score to pass (unspecified expectations do not count as passes).
- `pnpm conformance --suite liquidjs --filter expression` selects cases by repository and fixture ID substring.
- `pnpm conformance:baseline` records the current full-corpus gaps. Inspect the report before committing an updated baseline; this command is not a correctness fix.

The baseline gates authority failures, including unspecified expectations. Reports include pass/fail/unspecified counts per dialect and overall; unspecified cases remain in the denominator. A passing regression gate does **not** mean full Liquid compatibility. Output is compared exactly by a hash of the complete UTF-16 string, including whitespace. Ruby error expectations assert failure and phase where specified; LiquidJS errors compare normalized category and phase. Original messages remain in the report. Worker failures cannot be baselined.

Phase 1 changes measurement and fixture fidelity only: the jump from 4,688/6,296 under the old dual-agreement score to 5,649/6,298 under authority scoring is **not an engine improvement**. Contradictory LiquidJS/Ruby outcomes no longer make passing impossible. Ruby parser-error expectations are scored against Ruby, even when LiquidJS accepts the malformed syntax.

All three engines run in separate processes with in-memory template files, UTC, a per-case timeout, and a memory limit. A crash or timeout is an infrastructure failure and cannot be accepted into the baseline. Unsupported effect-liquid options are explicit results. The pinned Shopify gem is a third live oracle. Authority scoring still uses recorded Ruby expectations; live agreement is informational and confirms fixture fidelity. The Ruby worker has a 256 MiB address-space limit, the same per-case wall timeout, and dies with its supervisor. Ruby native score/output limits bound ordinary templates. LiquidJS-specific resource/typed-output options have explicit unsupported Ruby mappings.

## Sources and refresh

`upstreams.json` pins harttle/liquidjs, deepin-community/ruby-liquid, Shopify/liquid, and Shopify/liquid-spec. The latter is Shopify's portable YAML specification corpus. The LiquidJS npm oracle and source pin use the same release.

```sh
pnpm conformance:fetch
pnpm conformance:ruby:setup
pnpm conformance:import
pnpm conformance
```

Importing requires Ruby with Ripper as well as Node dependencies; the three-engine conformance run requires Ruby and the installed pinned oracle. The default `pnpm check` does not require oracle setup. Ruby setup builds the gem from the verified upstream commit and pins strscan 3.1.1 and bigdecimal 3.1.3; native builds need Ruby development headers, gcc and make. Fetches go into ignored `.cache/upstream`. Importers inspect TypeScript/Ruby syntax and YAML data without executing upstream test code. Imported fixtures contain pinned source URLs, source line numbers, contexts, separate globals, options, and expectations when recoverable. See [NOTICE.md](NOTICE.md) for attribution.

`import-inventory.json` lists scanned source files with hashes and every recognized candidate's disposition. Static inputs use JSON plus an explicit Ruby value encoding. Custom Drops, functions, generated data, filesystem mocks, unsupported syntax/options, and other setup that cannot be faithfully translated have exclusion reasons. Standalone templates and documentation snippets without complete inputs/expected output are catalogued with their text, rather than assigned invented inputs. This is a broad static import, not a claim that every upstream test is executable or discovered.

Ruby strict/strict2 parsing and host semantics can differ from LiquidJS. Original dialect options are retained as metadata; differences against those expectations remain visible and gated. Extending adapters should include an importer regression test so an extraction error cannot masquerade as an engine bug.

## Add a case

Add an object to `fixtures/local.json` with an explicit `authority: "ruby" | "liquidjs"`, a unique stable `id`, `source`, JSON `context`, `options`, `operation` (`render` or `parse`), and `origin.repository: "local"`. Optional `templates` maps names to source strings. An output expectation is `{"kind":"output","output":"exact text"}`; an error expectation is `{"kind":"error","phase":"parse"}` (phase may be omitted).

Run the selected case, inspect both results, and then run the full regression gate. Keep upstream-imported JSON generated; changes to extraction belong in the importers. Deliberate unsupported cases belong in the inventory or the explicit baseline, never in a silent skip list.

## Fixture value encoding

`context` contains assigns; `globals` contains the static environment visible to isolated renders. Shopify helper assigns and liquid-spec environments populate `globals`. Stub-file-system partials populate `templates`, never context.

Ruby values use a singleton object `{ "$liquid": { "type": "float", "value": "0.0" } }`. Numeric types are `integer`, `float`, and `decimal`, with decimal strings preserving precision and numeric kind; `symbol` carries a string `value`. `range` carries encoded `from`, `to`, and boolean `exclusive`. `hash` carries `entries` of encoded key/value pairs, preserving symbol keys. Plain string-key hashes remain JSON records. This reserved encoding is interpreted only in fixture value channels. The LiquidJS adapter projects tags to JavaScript values; the Ruby adapter passes them to the Ruby value model. Importer `instantiate:` descriptors are explicitly excluded because they require host classes/callbacks.

Importers inspect source without evaluating upstream tests. Regression tests cover partial keywords, positional contexts, static environments, numeric kinds, symbols, and ranges. Ruby extraction tests run when Ruby is installed; checked-in fixtures need only Node.

## Live Ruby and generated cases

`pnpm conformance --update-ruby-expectations` records supplemental live Ruby results for fixtures without supplied expectations in `ruby-expectations.json`. These cases have LiquidJS authority, so supplemental results never alter the LiquidJS score. Of the original 183 unspecified cases, Phase 1 declared exact expectations for two local Ruby cases; the oracle records 177 results and four explicit unsupported LiquidJS-option mappings. Reports compare supplemental results and detect stale fixture hashes. Recorded Ruby expectations are also independently confirmed by the live gem.

Date fixtures that use now/today carry the corpus clock `2024-01-01T00:01:58Z`, shared across all three processes. Suite parser modes normalize Ruby symbol spelling, so `:strict2` actually selects strict2 in both adapters. The oracle enables line numbers like upstream helpers, including nested liquid blocks.

`pnpm conformance:fuzz --seed 42 --cases 100` generates a bounded grammar corpus per dialect (maximum 1,000 cases each). It diffs effect-liquid against the appropriate live oracle and writes a seed-specific ignored report. `--record` appends discovered differences as explicit fixtures with seed/provenance and the oracle expectation; it does not alter the baseline. Infrastructure failures are fatal. Fuzzing stays outside `pnpm check`. Seed 42 found Ruby for-else after a zero limit; the recorded fixture now passes, with matching analysis/checker flow.
