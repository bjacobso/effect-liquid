# effect-liquid specification

Status: target specification with a working development preview. Written 2026-09-16. Normative terms describe the intended implementation, not existing functionality. This document owns behavior and architecture; PLAN.md owns sequencing.

## Implementation status and adjustments

The implemented surface is documented in README.md and CONFORMANCE.json; unchecked PLAN.md items remain future work. Target requirements below are not claims of completed parity.

The first implementation uses an explicit generic `Registry<E, R>` argument for rendering/checking extensions. `RenderConfig` and `TemplateLoader` are Effect services. Parsing, local analysis, and local checking have no service requirement; a `Language` service and custom tag parser registration are deferred. This avoids erasing extension types behind a nongeneric global service. The public APIs in source and their generated declarations are authoritative for the preview.

Project checking handles bounded literal render dependencies and explicit/inferred parameter contracts. Cycles, dynamic calls, shared includes, and loop-carried state have explicit conservative coverage rather than fixed-point summaries. Runtime resources are bounded, while local analysis/checking run bounded synchronous AST traversals; further cooperative checkpoints in these traversals remain future work.

Generated-output accounting includes captured content when generated and again when output. AST parsing yields between token batches. Parser depth has a hard ceiling of 256. The compatibility inventory uses `partial` for tested implemented subsets and records deliberate differences, including strict filter failure timing, raw trim support, and rejection of non-finite filter results.

## 1. Objective and boundaries

Build an independent implementation of Liquid that is useful both as an Effect-native renderer and as language infrastructure. Rendering, variable extraction, and checking MUST share parsed syntax and semantic rules. Extraction ships early; type checking follows a working renderer and scope model.

“From first principles” means implementing our own syntax model and evaluation machinery. LiquidJS may be used as a development oracle, never to parse, render, or analyze production requests. Inspecting its public behavior and source informs compatibility; this is not a claim of a legally isolated clean-room process. Any reused fixtures or code require recorded provenance and retained applicable notices.

Initial non-goals: a drop-in `Liquid` class, CommonJS/UMD bundles, arbitrary JavaScript execution, Shopify commerce objects, a full theme platform, an LSP, compile-time TypeScript inference from template string literals, and automatic exact input-schema inference. Package splitting and code generation are deferred until demonstrated need.

## 2. Compatibility policy

Target a named, pinned LiquidJS release plus explicit options, selected in milestone M0. Record release, commit, fixture provenance, runtime, and option set in the conformance manifest. Research against live documentation is not a version pin. Treat disagreements between documentation and that release as decisions with regression fixtures.

There is one initial language profile, `liquidjs`, with a growing supported subset. Unsupported syntax MUST produce a located diagnostic, never silent partial execution. The matrix MUST list each tag, filter, option, host-value behavior, and extension as supported, deferred, intentionally different, or unsupported, with test links. Do not claim complete compatibility until every row is resolved.

| Area | First usable release | Later compatibility work |
| --- | --- | --- |
| Syntax | Text, output, literals, paths, filters, whitespace trimming | Option-specific delimiters and parsing quirks |
| Tags | `assign`, `capture`, `if`/`elsif`/`else`, `unless`, `case`/`when`, `for`, `break`, `continue`, `raw`, `comment` | `render`, `include`, `liquid`, `echo`, inline comments, counters, `cycle`, `tablerow`, `layout`/`block` |
| Filters | `default`, `escape`, `upcase`, `downcase`, `append`, `size`, `plus`, `minus`, `times`, `divided_by` | Remaining string, numeric, collection, date, URL, and LiquidJS extension filters |
| Data | Nil, booleans, finite numbers, strings, arrays, plain records | Explicit adapters for host objects and Drops |
| Execution | In-memory string rendering and analysis | File adapters, dependency graph, streams, cache |
| Analysis | Located reads and writes, binding resolution, dynamic paths | Partial summaries and gradual checking |

LiquidJS has behavioral differences from Ruby Liquid and platform-specific features are a separate concern. Its [compatibility notes](https://liquidjs.com/tutorials/differences.html) inform the matrix; “Shopify compatible” is not an initial release claim.

Runtime defaults: Liquid truthiness, permissive missing-variable lookup, strict unknown filters, unknown tags rejected, no automatic output escaping. Strict filters intentionally differ from LiquidJS's default. Expose strict-variable checking and an explicit unknown-filter identity policy for conformance. Mark other options unsupported until implemented. The [LiquidJS options reference](https://liquidjs.com/tutorials/options.html) is the inventory source, not an implicit promise to implement all options.

## 3. Module and dependency design

Start with one package, `effect-liquid`, using ESM, an exports map, declarations, explicit `effect` peer compatibility, and no import-time registration or I/O. Pin a supported stable Effect release in M0; use one version consistently. Documentation consulted here uses Effect v3 APIs and does not prescribe using a prerelease or mixing major versions.

| Module | Responsibility |
| --- | --- |
| `Source`, `Diagnostic`, `Ast` | Source identity, spans, immutable syntax and errors |
| `Lexer`, `Parser` | Tokenization and parsing; no template loading |
| `Value`, `Semantics`, `Binding` | Liquid values, coercion, lookup, scope rules |
| `Analyze` | Read/write traversal, scope flow and dependency summaries |
| `Render` | Ordered evaluation, render state and output |
| `Filter`, `Tag`, `Builtins` | Explicit extension definitions and standard library |
| `TemplateLoader` | Canonical template resolution and source loading service |
| `Type`, `Check`, `Schema` | Later type algebra, checker and schema adapter |
| `Liquid` | Small composed public facade and standard layer |
| `node` | Optional filesystem and stream adapters using Effect platform services |

The AST does not depend on the renderer, loader, checker, or registry implementations. Analysis and rendering depend on shared semantics and binding definitions, not on one another. The Schema adapter targets our type algebra; Schema internals MUST NOT become the checker's representation. Core imports MUST work in a browser without Node polyfills. Importing the parser MUST NOT pull in Node adapters or the checker.

## 4. Effect throughout

Public fallible operations return `Effect.Effect<A, E, R>`; streaming returns `Stream.Stream<string, E, R>`. Use Effect composition for execution, service access, failure, interruption, resource lifetime, and instrumentation. Dependencies are services composed with layers, following [Effect's layer model](https://effect.website/docs/v3/requirements-management/layers).

Pure lexer loops, immutable constructors, and semantic helpers may be ordinary functions. “Effect throughout” does not require allocating an effect per character. Public parsing is lazy, typed, and interruptible through bounded work batches. No `runPromise`, `runSync`, hidden runtime, or detached fiber inside core modules. Promise bridges belong at application/adaptor boundaries. Async extensions use the same evaluator as built-ins.

Services: `Language` supplies immutable syntax/extension definitions; `RenderConfig` supplies policy and budgets; `TemplateLoader` resolves sources. Add cache as a replaceable service when M4 needs it. Clock-dependent filters use Effect's clock. Request-local scope, counters, and output MUST NOT live in a shared layer. Independent renders MUST be isolated.

Extensions preserve their error and service requirements through generic registry composition. A prototype in M0 MUST prove those types survive registration and rendering; erasing them to `any` or `unknown` is unacceptable. Expected extension failures are wrapped with a source span and typed cause. Defects and interruption remain distinguishable from expected template errors. CPU budgets cannot preempt a blocking host function; extensions are trusted application code.

## 5. Source and syntax

A source contains a stable ID, original text, and an optional revision. A span is `[start, end)` in zero-based UTF-16 code units. Diagnostics expose derived one-based line/column positions; CRLF counts as one line break. Preserve original offsets through whitespace trimming, Unicode, partial loading, and nested constructs.

Use a stateful lexer and a hand-written parser. Recognize delimiters, quotes, trim markers, raw/comment regions, and nested blocks without treating templates as regular-expression substitutions. Parse expression contexts with an explicit operator table, not JavaScript precedence. LiquidJS documents [right-to-left logical evaluation](https://liquidjs.com/tutorials/operators.html); precedence and optional operators such as `not` require fixtures against the pin. Parentheses used for ranges are not automatically general grouping syntax.

AST nodes are readonly tagged unions with spans. Expressions cover literals, variable access, ranges, conditions, and filter pipelines. A lookup stores a root and ordered property, numeric-index, or computed-expression segments. Nodes store syntax, not executable closures or engine instances. Preserve raw text needed for accurate diagnostics; lossless formatting and a separate concrete syntax tree are deferred.

Parsing MUST consume the entire construct, reject malformed nesting and unknown tags, and return a located failure. Initial parsing is fail-fast. Later editor recovery returns an explicitly incomplete document that rendering rejects. Limit source length, token count, and nesting before allocations or recursion become unbounded.

## 6. Runtime semantics

Centralize and test truthiness, nil/missing distinction, string conversion, equality, comparisons, containment, indexing, ranges, numeric coercion, filter coercion, and iteration order. Never substitute JavaScript truthiness or generic `String(value)` for unspecified Liquid behavior.

Normalize accepted host data into the Liquid value model. Distinguish missing access internally from explicit nil for diagnostics, even when permissive output is identical. Record handling permits own data properties only; do not invoke getters, traverse prototypes, or call methods implicitly. Reserve prototype-related keys at lookup boundaries. Any difference from LiquidJS host-object behavior is an explicit matrix row. Reject cycles, unsupported host values, and oversized inputs with typed boundary errors.

Scopes follow tag-specific rules, not JavaScript block scope. Assignment evaluates the right-hand side before writing; capture assigns its buffered string after evaluating the body. Conditions do not automatically create local scopes. Loops bind their item and loop metadata for the body, restore shadowed bindings on exit, and follow the pinned behavior for other assignments. Counters and cycle state are separate render registers. Pin fixtures for nested loops, empty loops, `else`, `break`, `continue`, shadowing, and assignment visibility before implementation.

Evaluate output and filters in source order. No parallel filter or sibling evaluation by default. Rendering a parsed document twice allocates fresh request state. Raw output is the default; `escape` is explicit, and a later global escape option must define interaction with safe/raw values. HTML escaping is not contextual escaping for JavaScript, CSS, or URLs.

## 7. Public contract sketch

These are schematic declarations, not compilable source. `R` and `E` below represent requirements and failures inferred from configured extensions; built-ins have no additional extension requirements.

```ts
parse(source, parseOptions?): Effect<Document, ParseError, Language>
analyze(document, analysisOptions?): Effect<Analysis, AnalysisError, Language>
analyzeProject(document, projectOptions?):
  Effect<Analysis, AnalysisError | LoadError | ParseError, Language | TemplateLoader>
render(document, context):
  Effect<string, RenderError | LoadError | ParseError | E,
    Language | RenderConfig | TemplateLoader | R>
renderStream(document, context):
  Stream<string, RenderError | LoadError | ParseError | E,
    Language | RenderConfig | TemplateLoader | R>
check(document, contract, checkOptions?): Effect<CheckResult, CheckError, Language>
checkProject(document, contract, projectOptions?):
  Effect<CheckResult, CheckError | LoadError | ParseError, Language | TemplateLoader>
```

The facade supplies a standard layer; local analysis never loads files. Project operations explicitly opt into loading. No renderer is needed to analyze or check. Expected findings are returned as diagnostics, while failed operations such as unreadable dependencies use the error channel. Results MUST record incomplete coverage when a requested dependency cannot be resolved in a tolerant project-analysis mode.

## 8. Variable extraction

An `Analysis` contains ordered occurrences, binding declarations, `externalRoots`, structural external paths, optional derived input paths, dependency edges, diagnostics, and `coverage: complete | partial` with reasons. Deduplicated views use first-occurrence order; the primary occurrence collection retains repeats. Complete means all relevant supported syntax was analyzed, not that dynamic values or runtime presence are known.

Each read records source span, original path, resolved binding or external root, lexical scope, and control-flow context. Writes are separate records. Bindings identify assignment/capture/loop/parameter/builtin origins. A computed path retains its AST; `a[b.c].d` records reads of both `a[b.c].d` and `b.c`. Quoted bracket keys are constants; comments and raw bodies produce no reads. Include filter arguments, conditions, ranges, loop options, and template-name expressions.

Resolution is flow-sensitive. A name assigned only in one branch is not definitely assigned after the join. A loop may run zero times. Reads before assignment can be external even when the name is assigned later. Preserve a may-be-external read when some incoming paths have no binding. Built-in names are local only within their valid scopes. External roots indicate possible inputs, not universally required fields.

Track simple aliases and loop-element provenance separately from syntactic reads. For `for p in products`, `p.title` is a local read with derived `products[*].title`. A filter transformation may make provenance unknown; do not fabricate an exact source path. Branch guards may be recorded without attempting theorem proving. Analysis never invokes extension runtime handlers.

Acceptance examples:

| Template | Required analysis behavior |
| --- | --- |
| `{{ user.name &#124; default: fallback }}` | External `user.name` and `fallback` |
| `{% assign x = user.name %}{{ x }}` | External `user.name`; local write/read `x` |
| `{{ x }}{% assign x = 1 %}` | First `x` remains external |
| `{% if flag %}{% assign x = 1 %}{% endif %}{{ x }}` | External `flag`; `x` may be external at join |
| `{% for p in products %}{{ p.title }}{% endfor %}` | External `products`; local `p.title`; derived element path |
| `{{ labels[locale] }}` | Computed access plus independent `locale` read |
| `{% raw %}{{ ignored }}{% endraw %}` | No variable reads |

LiquidJS's [analysis API](https://liquidjs.com/tutorials/static-analysis.html) is useful prior art for global/local references and locations. Our result shape and completeness policy are independent public contracts.

## 9. Templates, loading and streaming

A loader resolves `(specifier, referrer, kind)` to canonical identity and loads text plus revision. `kind` distinguishes partial/layout lookup. Provide in-memory first, Node filesystem later; no implicit network access. Resolution policy belongs to the loader. Filesystem adapters enforce configured roots after canonicalization, including symlinks.

`render` partials receive explicit arguments and configured globals, with isolated local state. This matches the scope boundary described in [LiquidJS's render documentation](https://liquidjs.com/tags/render.html). `include` follows its distinct shared-context behavior, verified against the baseline. Literal dependencies can be analyzed transitively. Argument bindings translate callee input paths back to caller provenance; missing isolated parameters are callee diagnostics, not invented caller globals.

Computed template names yield unresolved edges unless bounded candidate names can be established. Even quoted names with embedded output are not necessarily static. Cycles in analysis use visited nodes, bounded summary iteration, and an explicit partial result when convergence cannot be established. Runtime recursion is permitted only within configured depth/work limits. Identity, language/registry version, options, and source revision participate in cache keys; project summaries also track dependency revisions. Never cache request contexts or rendered output by default.

`renderStream` is pull-driven, preserves output order, observes cancellation, and releases loader/extension resources. Buffered `render` and collected streaming output MUST agree. A late error may follow already-emitted chunks; there is no rollback. Capture and layout operations may buffer bounded regions. Budget total work, recursion, loop iterations, source/input size, buffered output, and emitted output; document units and select finite defaults before shipping. Count emitted output in UTF-8 bytes. Yield periodically during CPU-heavy work so interruption can be observed.

## 10. Extension contracts

Registries are immutable values assembled before use. Filters declare name, runtime implementation, argument shape, and eventually type signature/coercion behavior. Custom tags additionally declare parser behavior, child nodes, expressions read, bindings introduced, and scope/control-flow transfer. All built-ins implement the same analysis obligations.

Missing analysis metadata yields a located opaque-extension diagnostic and partial coverage. Missing type signatures produce `Unknown`, not `any` or a fabricated inferred type. Strict checking rejects coverage gaps. Changing a registry invalidates affected parsed/analysis caches. Extension handlers cannot silently mutate the global registry or leak request-local bindings into other renders.

## 11. Gradual type checking

Checking consumes an AST, a declared context contract, globals, and extension signatures. It is static analysis, separate from validating an actual context value at runtime. Initial types: `Unknown`, `Never`, `Nil`, boolean/string/number literals and primitives, arrays, tuples, records with optional fields/index signatures, and finite unions. Track missing separately where presence matters.

Build a small flow environment over shared binding rules. Infer assignments and captures, derive loop item and metadata types, merge branch environments, and conservatively widen loops. Narrow supported truthiness and equality guards using Liquid semantics: empty strings, zero, and empty collections do not become false merely because JavaScript treats some of them that way. Model `default` through its filter contract, including false-handling options. Cap union growth and recursive analysis, emitting a coverage reason when precision is lost.

Check static property names, receiver/index compatibility, filter arity and argument types, supported operator domains, optional accesses, and partial arguments. Compatibility mode accepts documented runtime coercions and warns about suspicious accesses; strict mode reports unsafe optional accesses, implicit coercions outside the declared strict policy, and unknown coverage as errors. Each filter signature records accepted Liquid inputs and resulting types; a TypeScript callback signature alone is insufficient.

`CheckResult` contains ordered diagnostics and coverage reasons. A document passes when no error diagnostics exist; report whether coverage is complete alongside pass/fail. Strict mode cannot pass with partial coverage. Local checking of a document with unanalyzed partial calls is partial; use project checking for a complete dependency check. This guarantee assumes valid context data and accurate extension contracts, and excludes I/O failures, resource exhaustion, and arbitrary host effects.

The later Effect Schema adapter projects the schema's decoded/output shape into the type algebra, since that is what rendering receives. Runtime decoding is an explicit optional operation before rendering. Support primitives, structs, optional properties, arrays, tuples, unions, and bounded lazy recursion first. Refinements, transforms, and declarations without structural meaning require metadata or yield `Unknown`; never execute arbitrary transformations to infer types. [Effect Schema](https://effect.website/docs/v3/schema/introduction) supplies validation infrastructure, not a Liquid type checker.

Required checker examples: `user.nmae` against `{ user: { name: string } }` fails; a declared optional nested record requires a supported guard in strict mode; a loop item has its collection element type; a custom filter without a type signature yields unknown coverage; an incompatible partial argument points to both caller and callee contract. Extracting a path alone does not establish the field's type or requiredness.

## 12. Diagnostics and validation

Diagnostics carry stable code, severity, message, primary span, related locations, and optional notes. Dependency failures retain the inclusion chain. Public expected errors are tagged unions such as `ParseError`, `LoadError`, `MissingVariable`, `UnknownFilter`, `FilterFailure`, `InvalidContext`, and `ResourceLimitExceeded`. Do not collapse every failure into a string or swallow Effect causes. Tracing spans cover parse/analyze/load/render/check; never log context values by default.

Validation includes parser/span fixtures, semantic unit tests, reference conformance with explicit options, analysis flow fixtures, checker positive/negative cases, malformed-input fuzzing, cancellation/resource tests, and ESM/browser import tests. Differential mismatches are triaged rather than automatically copied into semantics. Reference crashes or hangs must be bounded by a separate-process timeout.

Benchmark cold parsing, warm rendering, local/project analysis, checking, peak memory, streaming first chunk, and repeated concurrent requests. Record runtime and fixture sizes. Set regression thresholds after measuring the first implementation; no unsupported speed claims. No release may advertise a feature without a matrix entry and acceptance tests.

### Executable upstream corpus

The correctness harness in `scripts/conformance/` compares pinned LiquidJS and effect-liquid in isolated workers using the generated `conformance/fixtures/` corpus. It checks exact output and normalized error category/phase, independently evaluates upstream expectations, and gates new or changed gaps against an explicit baseline. Imported source provenance, licenses, and non-executable candidate reasons are retained. Ruby tests supply expectations rather than live Ruby execution. Timing comparison is deferred; see `conformance/README.md` for the implemented contract and limits.

### Counter, cycle, and collection-filter expansion

The implemented AST now includes `Counter` and `Cycle`. Counter operations read/write a request-local environment below assignment bindings, seeded by numeric input where present (the pinned LiquidJS behavior). Cycle keys combine the evaluated group and candidate source syntax; only the selected candidate is evaluated. Includes share state; isolated renders get fresh cycle state and their own parameter environment. Input contexts remain immutable to callers. Analysis records counter declarations, conservative optional input-seed dependencies, and cycle expression reads; checking treats unshadowed counters as numbers.

The initial array-filter batch includes sorting, mapping, summing, compaction, concatenation, uniqueness, push/pop/shift/unshift, slicing, and property-based matching/search. Scalar inputs are singleton sequences and nil inputs empty sequences where applicable. Operations do not mutate input arrays. Type signatures conservatively mark value-dependent results unknown. Expression-based filters and full property-string/missing-value compatibility remain deferred.

### Liquid blocks and table rows

`liquid` expands newline-delimited statements into the existing AST without synthetic source text. Every nested token retains its original offset. The parser applies shared token and depth budgets across expansion, and supports inline and block comments. Nested blocks cannot be closed by tags outside the enclosing `liquid` construct.

`TableRow` carries collection, optional `cols`/`offset`/`limit`, a scoped item binding, and a body. Its streaming renderer accounts for generated HTML in the shared byte budget and enforces iteration limits. Metadata includes ordinary loop indexes plus row/column indexes and column boundary flags. Analysis and checking bind `tablerowloop` locally and visit all option expressions. Raw-in-liquid and table-row control-flow edge cases remain explicitly partial compatibility.

### Loop continuation and partial binding expansion

`For` stores a cursor key derived from the loop variable and collection source syntax, plus an explicit continuation flag. `continue` in an offset is not a variable read. Cursors live in request state, are shared through include, and reset for an isolated render. Offset then limit then reversal follow the default pinned LiquidJS order; the cursor advances by the selected length before execution. The original empty collection selects `else`; slicing a nonempty collection down to zero does not.

Partial AST nodes carry optional `with` and `for` bindings. Include supports `with`; render supports both. Named/with parameters and loop items inhabit the child assignment scope, separate from counter seed state. Render-for iterations reuse child assignments and registers, overwrite item/loop bindings each iteration, and share the outer resource budget. An empty render-for collection does not load its template; a nonempty invocation loads/parses once for its iterations. Explicit aliases are preferred; omitted render-for aliases retain the pinned oracle's `undefined` key behavior. Dependency metadata records item bindings so project paths gain `[*]` and project checks use element types.

### String filter expansion

String built-ins now live in an internal `StringFilters` module composed into the default registry. The batch includes truncation, first/last replacement/removal, optional strip character sets, newline/whitespace transforms, CJK-aware word counts, and HTML/text escaping/stripping. Literal replacement text is never interpreted as JavaScript replacement syntax. Unshortened `truncate` results preserve the input value type, so its checker output remains conservatively unknown. `truncatewords` boundary behavior and `escape_once` entity recognition follow the pinned LiquidJS release. HTML stripping uses forward searches with precomputed final closer positions to avoid repeated scans on unmatched openers.

### URL filters and typed built-in failures

The internal `UrlFilters` module implements component/form/URI encodings and pinned slugification modes. Expected JavaScript `URIError` exceptions become `BuiltinFilterError` values, wrapped with the filter name and source span by rendering. The built-in registry now declares this error type; default buffered and streaming render signatures include it in `FilterFailure`. Custom registry error/service types remain preserved, and unexpected exceptions remain defects. Conformance reports include wrapped cause messages. The decoding order and Latin transliteration intentionally follow the pinned LiquidJS release rather than claiming universal URL or slugification semantics.

### Embedded collection expressions

The internal expression parser is shared by template parsing and embedded predicates. The filter registry distinguishes native callbacks from declarative expression operations; rendering dispatches by the registered descriptor so native overrides remain effective. Predicates run with an item-local scope, the caller's remaining variables, and the active registry. Scope/depth cleanup uses Effect finalizers. Iteration, predicate source length, expression evaluation, and nested invocation depth count toward render budgets; searching short-circuits. Filtering uses exact boolean results and searching uses the pinned JavaScript truthiness behavior.

Literal aliases/predicates are analyzed and checked with item bindings. Reads retain the whole argument span because decoded escapes can prevent exact original offsets; analysis reports this limitation. Dynamic/deep predicates are explicit static-coverage gaps. Project analysis accepts the active registry. Selector properties support static dotted/bracket keys; map/sort/sum retain LiquidJS's dotted-path interpretation. Dynamic property indexes and missing-versus-nil fidelity remain partial.

### Numeric filter compatibility

Arithmetic uses the pinned LiquidJS numeric conversion rather than numeric-prefix parsing: booleans become zero/one, numeric strings convert as a whole, and invalid conversions become zero. Arrays convert through their comma-separated representation. This intentionally differs from Ruby expectations for booleans and partially numeric strings; those corpus cases remain recorded gaps even when both JavaScript engines agree. Rounding compensates scaled binary multiplication by one relative machine epsilon and rounds magnitudes before restoring the sign. Precision may be negative or fractional. Optional integer division floors the quotient when its flag coerces to a nonzero number. Non-finite results remain outside the accepted Liquid value domain.

Filter signatures now optionally declare positional argument kinds, falling back to the shared `argument` kind for unspecified positions. The checker diagnoses each incompatible argument at its own span. `divided_by` declares a numeric divisor and optional boolean flag; compatibility mode warns about runtime coercions, while strict mode rejects them.

### Base64 text filters

`base64_encode` and `base64_decode` are Effect-native filters with string output metadata. An independent byte codec uses `TextEncoder`/`TextDecoder` so browser bundles need no Node globals. Encoding emits standard padded Base64. Decoding follows the pinned Node oracle, including its low-byte interpretation of UTF-16 code units, acceptance of the URL-safe alphabet, skipped invalid characters, termination at the first padding character, and discarded incomplete trailing bits. UTF-8 decoding replaces malformed sequences and preserves BOM characters. This intentionally provides the same behavior in both environments; it does not claim parity with every upstream browser-specific implementation. Existing input normalization and output limits remain in force, and streaming emits the same text as buffered rendering.

### Opt-in grouped expressions

`ParseOptions.groupedExpressions` enables parentheses around conditions and filter pipelines. Ranges retain their existing syntax, and grouped pipelines can supply their endpoints. Without the option, parentheses are reserved for ranges. Grouping preserves the existing expression node types and original inner spans, so variable extraction and checking traverse the same AST without reparsing template text. Nested groups count toward the existing expression-depth limit. Ungrouped logical operators remain right-associative.

A parsed document records `groupedExpressions: true` when enabled; absence means false, preserving compatibility with existing document values. Rendering and project traversal pass this syntax setting to loaded partials. Embedded predicate compilation, static extraction, and typechecking also read it from the containing document. The conformance adapter now exercises both enabled and explicitly disabled fixtures instead of treating the option as unsupported configuration.

### Virtual properties and sequence indices

String/array `length` and `size` return their UTF-16 length or item count. Record `size` uses an own property first, including explicit nil/false/zero values; otherwise it counts own enumerable keys. Getters are never invoked by lookup and are rejected during context normalization. The `size` filter remains distinct from property lookup and returns zero for records under the pinned LiquidJS behavior.

Negative numeric array keys count from the end; negative string offsets do not. String index keys must use canonical nonnegative integer spelling, so `"0"` works while `"01"`, `"1.0"`, and `"-1"` do not. Static checking recognizes length/size, accounts for missing optional record-size fields with a numeric fallback, and resolves negative numeric tuple indices to the corresponding element type. Variable analysis continues to report the syntactic property path rather than inventing a field read for the virtual fallback.
