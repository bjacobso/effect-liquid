# Conformance corpus

Run `pnpm conformance` to compare every executable fixture against the pinned LiquidJS release and effect-liquid. Results are written to ignored `conformance/reports/latest.json` and `.md`. No timing measurements are collected.

- `pnpm conformance:check` fails on new or changed gaps, resolved gaps awaiting baseline removal, stale baseline cases, and worker failures.
- `pnpm conformance:strict` requires both engines to agree and satisfy every supplied upstream expectation.
- `pnpm conformance --suite liquidjs --filter expression` selects cases by repository and fixture ID substring.
- `pnpm conformance:baseline` records the current full-corpus gaps. Inspect the report before committing an updated baseline; this command is not a correctness fix.

The baseline records existing compatibility debt, including cases where both JavaScript engines disagree with a Ruby expectation. A passing regression gate does **not** mean full Liquid compatibility. Output is compared exactly by a hash of the complete UTF-16 string, including whitespace. Errors are compared by phase and normalized category, not identical messages; original messages remain in the report. Upstream error expectations assert failure and phase where specified, not Ruby exception-class equivalence.

For malformed syntax, prefer rejecting a template that the upstream Liquid specification expects to fail over matching LiquidJS's more permissive parser. For example, liquid-spec expects `{% if x == %}{% endif %}` to fail during parsing; effect-liquid rejects it, while LiquidJS 10.29.0 parses it. The report calls this a LiquidJS `mismatch` and the regression gate tracks it as a `known-gap`, but relaxing our parser would violate the fixture's expected result. The parser and harness tests lock in this distinction. `conformance:strict` cannot pass every imported fixture while the upstream expectations and LiquidJS disagree; resolve such conflicts by an explicit compatibility policy, not by treating every mismatch as a bug in effect-liquid.

Both engines run in separate processes with in-memory template files, UTC, a per-case timeout, and a memory limit. A crash or timeout is an infrastructure failure and cannot be accepted into the baseline. Unsupported effect-liquid options are explicit results. The harness runs JavaScript engines only; Ruby supplies expected fixtures, not a third live execution engine.

## Sources and refresh

`upstreams.json` pins harttle/liquidjs, deepin-community/ruby-liquid, Shopify/liquid, and Shopify/liquid-spec. The latter is Shopify's portable YAML specification corpus. The LiquidJS npm oracle and source pin use the same release.

```sh
pnpm conformance:fetch
pnpm conformance:import
pnpm conformance
```

Importing requires Ruby with Ripper as well as Node dependencies; running checked-in fixtures does not require Ruby or upstream checkouts. Fetches go into ignored `.cache/upstream`. Importers inspect TypeScript/Ruby syntax and YAML data without executing upstream test code. Imported fixtures contain pinned source URLs, source line numbers, contexts, options, and expectations when recoverable. See [NOTICE.md](NOTICE.md) for attribution.

`import-inventory.json` lists scanned source files with hashes and every recognized candidate's disposition. Static JSON inputs are executable. Custom Drops, functions, generated data, filesystem mocks, unsupported syntax/options, and other setup that cannot be faithfully translated have exclusion reasons. Standalone templates and documentation snippets without complete inputs/expected output are catalogued with their text, rather than assigned invented inputs. This is a broad static import, not a claim that every upstream test is executable or discovered.

Ruby strict/strict2 parsing and host semantics can differ from LiquidJS. Original dialect options are retained as metadata; differences against those expectations remain visible and gated. Extending adapters should include an importer regression test so an extraction error cannot masquerade as an engine bug.

## Add a case

Add an object to `fixtures/local.json` with a unique stable `id`, `source`, JSON `context`, `options`, `operation` (`render` or `parse`), and `origin.repository: "local"`. Optional `templates` maps names to source strings. An output expectation is `{"kind":"output","output":"exact text"}`; an error expectation is `{"kind":"error","phase":"parse"}` (phase may be omitted).

Run the selected case, inspect both results, and then run the full regression gate. Keep upstream-imported JSON generated; changes to extraction belong in the importers. Deliberate unsupported cases belong in the inventory or the explicit baseline, never in a silent skip list.
