# Implementation plan

Status: not started. This task delivers documentation only. All implementation checkboxes intentionally remain open. [SPEC.md](./SPEC.md) defines the intended behavior; [README.md](./README.md) introduces the project.

## Delivery strategy

Build a thin parse → analyze → render path first. Make source locations and binding rules foundational so checking does not require replacing the renderer's AST. Ship a useful subset before pursuing the entire LiquidJS surface. A milestone is complete only when its acceptance criteria pass and documentation accurately describes what exists.

Dependency order: M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7. A minimal binding analyzer starts in M1; M3 validates full flow behavior against the renderer. No calendar estimates are assigned before the baseline and first slice are measured.

## M0 — Baseline and package foundation

- [ ] Select and pin a LiquidJS release, commit, reference options, and compatible stable Effect/tooling versions; record why they were selected.
- [ ] Inventory every baseline tag, filter, option, host-value behavior, and public feature in a conformance manifest. Mark support/defer/divergence explicitly.
- [ ] Record fixture provenance and applicable notices; use original fixtures where possible.
- [ ] Scaffold one ESM TypeScript package, exports/declarations, strict compiler settings, lockfile, formatting/linting, test runner, and CI. Default to pnpm and Vitest unless a concrete compatibility issue requires a change.
- [ ] Prototype Effect service and error inference through a registry with one effectful custom filter; verify typed failures, interruption, and no internal runtime execution.
- [ ] Establish Node and browser test targets and an adapter boundary; document exact supported versions.

Exit: package import/build checks pass; a small Effect program demonstrates the proposed API's type propagation; the pinned oracle runs one bounded original fixture. Unsupported features and intentional strict-filter/host-value differences are visible. Do not start a broad interpreter until the extension typing decision works.

## M1 — Source model, parser and first extraction

- [ ] Implement source IDs, UTF-16 spans, line tables, diagnostics, tokens, and readonly AST unions.
- [ ] Implement text/output scanning, literals, dot/bracket/computed paths, filters, and whitespace trim markers.
- [ ] Add the first-release block grammar, raw/comment handling, ranges, and the pinned logical precedence rules.
- [ ] Implement bounded parsing with interruption checkpoints and located failures for malformed or unsupported constructs.
- [ ] Add a traversal reporting all reads/writes and straightforward assignment/loop bindings; keep flow uncertainty explicit until M3.
- [ ] Add the README's parse/extraction example as a fixture and mark the exact supported subset.

Exit: fixtures cover quoted delimiters, CRLF/Unicode spans, nested blocks, dynamic-index subexpressions, filter arguments, raw/comment exclusion, and truncated input. `parse` and local analysis work without a loader or renderer. No regular-expression-only variable extraction.

## M2 — Liquid semantics and Effect rendering

- [ ] Implement accepted input normalization, missing/nil handling, coercion, truthiness, lookup, comparison, ranges, and iteration rules.
- [ ] Implement request-local bindings and control flow for the first-release tags and ten filters listed in SPEC §2.
- [ ] Implement ordered Effect evaluation and buffered output, typed failures, tracing, and immutable standard registry/layer composition.
- [ ] Choose finite documented limits for input, parsing, work, nesting, iterations, and output; enforce them before excessive allocation.
- [ ] Differential-test each supported construct and option against the pin, including assignment/capture and loop scope boundaries.
- [ ] Check extension failures, no context mutation, independent concurrent renders, and interruption during large loops.

Exit: the README render example runs; every claimed subset feature has passing conformance cases or an explicit divergence. Empty strings and zero follow Liquid truthiness. Missing/strict behavior, prototype/getter restrictions, shadowing, and failure locations have regression tests. No `any` escape in the public extension contract.

## M3 — Flow-aware variable analysis

- [ ] Implement stable occurrence and binding IDs, structured paths, external-root/path views, control-flow context, and coverage reasons.
- [ ] Resolve reads before writes, branch joins, zero-iteration loops, shadow restoration, capture timing, and built-in scope.
- [ ] Add alias and loop-element provenance without confusing derived input paths with syntactic reads.
- [ ] Require traversal/scope metadata for built-ins; surface opaque custom tags and unknown transformations.
- [ ] Add all SPEC §8 examples and further nested loop/branch fixtures with exact occurrence spans.

Exit: extraction accurately distinguishes locals from possible external inputs. Conditional assignments never incorrectly erase dependencies. Repeated reads remain separate occurrences. Analysis performs no runtime handler calls and makes no claim that every external read is required.

Release gate A: publish a preview only after M0–M3 pass, with in-memory rendering and variable extraction advertised as the supported subset. Update README examples from illustrative to tested usage at that point.

## M4 — Partial templates and project analysis

- [ ] Define canonical loader identity, source revision, referrer/kind resolution, and in-memory loader composition.
- [ ] Implement `render` and `include`, covering parameters, `with`/`for`, globals, isolation versus shared scope, and dynamic names.
- [ ] Add project analysis with dependency edges, caller/callee provenance, isolated-parameter diagnostics, unresolved edges, and bounded cyclic summaries.
- [ ] Add Node filesystem adapter with canonical-root checks, including symlinks and relative paths.
- [ ] Add a bounded parsed-template cache keyed by source/registry/options revisions; track transitive summary invalidation.
- [ ] Test loader failures, recursion limits, dynamic targets, repeated inclusion, and dependency changes.

Exit: multi-file rendering and analysis agree about scopes. A changed child invalidates its project summary. Dynamic/cyclic uncertainty is visible. Missing isolated arguments are not misreported as caller globals. Local APIs still perform no loading.

## M5 — Streaming and compatibility expansion

- [ ] Add pull-driven Effect Stream rendering, bounded buffering for capture/layout, and Node/Web stream adapters as needed.
- [ ] Verify string/stream equivalence, late failure behavior, cancellation cleanup, slow-consumer backpressure, and global output/work accounting.
- [ ] Implement remaining tags in explicit matrix batches: `liquid`/`echo`/inline comments; counters/`cycle`; `tablerow`; `layout`/`block`.
- [ ] Expand filters by family, with runtime semantics, analysis/type metadata hooks, and conformance fixtures in each batch.
- [ ] Implement or explicitly defer each remaining option and host adapter. Keep platform commerce features outside the core.
- [ ] Add bounded fuzz/differential runs and initial parse/render/analysis/stream benchmarks; establish measured regression budgets.

Exit: every expanded feature has a tested row. Collected stream output equals buffered output, interrupted consumers release resources, and slow consumers do not cause unbounded queues. Publish the actual conformance report; remaining gaps prevent a full-compatibility claim but do not block an honestly scoped release.

## M6 — Gradual document checker

- [ ] Implement the independent type algebra and programmatic context/global contract builder.
- [ ] Reuse M3 binding/control-flow rules for assignment inference, branch joins, loop item types, supported guards, and bounded widening.
- [ ] Add filter signatures for all shipped built-ins, including coercions and `default` behavior.
- [ ] Implement property/index, operator, filter-argument, optional-access, and partial-contract diagnostics.
- [ ] Implement local/project checking, compatibility/strict modes, deterministic diagnostic order, and explicit unknown/partial coverage.
- [ ] Add positive and negative fixtures for every checker rule and tests proving no custom runtime code executes during checks.

Exit: all SPEC §11 examples pass or fail as specified. A strict check with unknown coverage cannot pass. Optional values narrow using Liquid semantics. Error locations identify both partial arguments and their declared contracts. No requirement to implement an LSP or TypeScript template-literal parser.

## M7 — Effect Schema adapter and usable tooling

- [ ] Project supported decoded Schema shapes into the type algebra; document transforms/refinements and unknown fallbacks.
- [ ] Provide optional Effect-based runtime context decoding separately from static checking.
- [ ] Add a small CLI for parse/analyze/check/render with stdin or file input, JSON diagnostics, stable exit codes, and the same library APIs.
- [ ] Add end-to-end examples for extraction, declared contracts, Schema validation, custom Effect filters, and project checking.
- [ ] Verify published-package ESM exports/declarations, browser core imports, peer-dependency bounds, documentation examples, and release contents.

Exit: users can check a template against a schema-backed contract without rendering it; incompatible data fails explicit runtime validation; unsupported schema shapes remain visible. The CLI produces machine-readable findings without mixing logs into JSON output. README accurately states support and limitations.

## Validation and change control

For each feature, require syntax/span tests where relevant, semantic tests, analysis/checker coverage or explicit uncertainty, and a conformance-manifest update. CI runs build/type checking, unit/integration tests, and the bounded supported-feature oracle suite. Run larger fuzz/benchmark suites on scheduled or release jobs once infrastructure exists.

Before each release, review SPEC/README/API consistency, unresolved high-impact failures, cancellation/resource behavior, and fixture provenance. Documentation-only edits need link/content checks, not an invented engine test run.

## Decisions to resolve during implementation

| Decision | Default direction | Resolve by |
| --- | --- | --- |
| Effect version and extension typing | Stable release; infer extension requirements without erasure | M0 |
| Compatibility baseline | One pinned LiquidJS release and explicit options | M0 |
| Runtime/toolchain versions | pnpm, strict TypeScript, Vitest; record tested targets | M0 |
| Limit values and checkpoint frequency | Finite defaults, measured on ordinary and hostile fixtures | M2 |
| Full host-object compatibility | Plain records first; explicit adapters and recorded deviations | M5 |
| Strict-check coercion policy | Document per operator/filter; preserve permissive runtime mode | M6 |
| Package license/publication name | Record deliberately before first publication | Release gate A |

Revisit architecture only when a milestone exposes a concrete constraint. Keep formatter, editor recovery, LSP, incremental checking, exact schema inference, bytecode/JIT compilation, and separate packages out of the initial critical path.
