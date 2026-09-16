# effect-liquid

An independent Liquid template engine in TypeScript, built around Effect. Parse templates into a source-located AST, render them, extract variable dependencies, and check them against declared data contracts.

**Status: working development preview.** Core rendering and analysis are implemented; the checker is experimental. The package is not published. [CONFORMANCE.json](./CONFORMANCE.json) inventories the supported subset and remaining gaps against LiquidJS 10.29.0. LiquidJS is a development-only comparison engine, never a runtime dependency.

## Develop

```sh
pnpm install
pnpm check
pnpm benchmark
```

Uses Node.js 22+, pnpm 10.20.0, TypeScript 5.9.3, and Effect 3.22.2. CI targets Node 22 and 24. The core bundles for browsers; platform filesystem code lives in a separate module. All exports are ESM with TypeScript declarations.

## Parse and render

```ts
import { Effect } from "effect"
import * as Liquid from "effect-liquid/Liquid"

const program = Effect.gen(function* () {
  const document = yield* Liquid.parse("Hello, {{ user.name | upcase }}!")
  const analysis = yield* Liquid.analyze(document)
  const output = yield* Liquid.render(document, { user: { name: "Ada" } })
  return { output, inputs: analysis.externalRoots }
}).pipe(Effect.provide(Liquid.layer))

console.log(await Effect.runPromise(program))
// { output: "Hello, ADA!", inputs: ["user"] }
```

Parsing, local analysis, and local checking need no services. Rendering requires `RenderConfig` and `TemplateLoader`; `Liquid.layer` provides defaults and an empty in-memory loader. Run Effects at the application boundary. Core modules do not create runtimes.

Implemented tags: `assign`, `capture`, `if`/`elsif`/`else`, `unless`, `case`/`when`, `for`, `break`, `continue`, `raw`, `comment`, `echo`, and basic `render`/`include`. Filters cover the initial numeric and string operations plus `split`, `join`, `map`, `first`, `last`, and `reverse`. See the inventory for exact coverage.

Defaults use Liquid truthiness, permissive missing variables, strict unknown filters, and unescaped output. Use `escape` when HTML escaping is appropriate. Plain records and arrays are accepted; accessors, class instances, cyclic data, and non-finite numbers are rejected. Context data is copied into request-local state.

The preview supports `increment`, `decrement`, and `cycle`. Counters use request-local input state independently of `assign` and `capture`; numeric input values seed counters. `include` shares counter/cycle state, while `render` gets isolated state. Rendering never mutates the caller's context.

Collection filters include `sort`, `sort_natural`, `map`, `sum`, `compact`, `concat`, `uniq`, `push`, `pop`, `shift`, `unshift`, `slice`, `where`, `reject`, `find`, `find_index`, and `has`. Scalar/nil coercion, dot-separated property paths, and nonmutating operations are supported. Selectors (`where`, `reject`, `find`, `find_index`, `has`) also accept static bracket keys. `map`, `sort`, and `sum` retain the pinned dotted-path behavior. Dynamic bracket keys and some Ruby/JavaScript missing-value differences remain compatibility gaps. `json` and `to_integer` support typed output comparisons.

`liquid` blocks support newline-separated tags, nested control flow, `echo`, and comments while preserving original source spans. `tablerow` generates row/cell HTML with `cols`, `offset`, `limit`, and scoped `tablerowloop` metadata. Generated markup counts toward the output budget.

```liquid
{% liquid
  # Render two products per row
  tablerow product in products cols:2
    echo product.title | escape
  endtablerow
%}
```

Raw blocks inside `liquid`, table-row control-flow quirks, and permissive malformed-syntax compatibility remain gaps.

String filters include first/last replacement and removal, custom strip character sets, `truncate`, `truncatewords`, `strip_newlines`, `newline_to_br`, `squish`, `normalize_whitespace`, `number_of_words`, `strip_html`, `escape_once`, and `xml_escape`. Replacement strings are literal; CJK word counting is supported. Truncation and entity handling follow the pinned LiquidJS behavior, including documented conformance differences from Ruby expectations.

URL filters include `url_encode`, `url_decode`, `cgi_escape`, `uri_escape`, and `slugify` modes (`default`, `raw`, `pretty`, `ascii`, `latin`, `none`). They follow the pinned LiquidJS behavior: URL decoding replaces plus signs after percent-decoding, and Latin slugification uses its specific transliteration set. Malformed percent encodings and invalid UTF-16 become located `FilterFailure<BuiltinFilterError>` values in the Effect error channel, also during streaming.

Numeric filters follow LiquidJS whole-value coercion: `true` becomes one, and invalid numeric strings become zero. This differs from Ruby Liquid's treatment of booleans and numeric string prefixes. `round` handles negative ties away from zero, decimal multiplication error, and negative or fractional precision. `divided_by` accepts an optional integer-division flag; a flag that coerces to a nonzero number floors the quotient, including negative quotients. Strict checking expects a numeric divisor and a boolean flag. Non-finite results remain rejected by the finite Liquid value boundary.

`base64_encode` and `base64_decode` handle UTF-8 text in Node and browser bundles without requiring `Buffer`. Decoding follows the pinned Node LiquidJS oracle: it accepts unpadded and URL-safe input, ignores invalid characters, stops at padding, preserves a leading BOM, and replaces malformed UTF-8. Encoding replaces lone UTF-16 surrogates. These are permissive text filters, not strict Base64 validators or binary-data APIs.

Expression filters include `where_exp`, `reject_exp`, `find_exp`, `find_index_exp`, `has_exp`, and `group_by_exp`. Predicates run as Liquid expressions with a local item alias, caller variables, and registered filters. They share iteration, work, and nesting budgets with the render. Native overrides of these names are respected.

```liquid
{{ products | where_exp: "product", "product.price > minimum" | map: "title" | join: ", " }}
```

Literal predicates participate in variable extraction and checking. Their locations point to the containing string argument, so analysis reports conservative location coverage. Dynamic predicate strings report partial static coverage. `analyze(document, registry)` and `analyzeProject(document, options, registry)` accept the active registry for extension-aware analysis. Filter registry entries are either native callbacks or declarative expression-filter entries; callers inspecting entries should narrow with `"expression" in filter` before accessing `.run`.

## Extract variables

```liquid
{% assign heading = user.name | upcase %}
{% for product in catalog.products %}
  {{ heading }}: {{ product.title }} {{ labels[locale] }}
{% endfor %}
```

`Liquid.analyze(document)` returns:

| Field | Meaning |
| --- | --- |
| `externalRoots` | Possible application inputs: `user`, `catalog`, `labels`, `locale` |
| `externalPaths` | Paths such as `user.name`, `catalog.products`, and `labels[locale]` |
| `occurrences` | Every read, its original expression/span, bindings, and control context |
| `bindings` | Assignment, capture, counter, loop, filter item, and built-in declarations |
| `derivedInputPaths` | Simple alias/loop provenance such as `catalog.products[*].title` |
| `dependencies` | Partial calls, expressions, and arguments |
| `coverage`, `coverageReasons` | Explicit gaps in analysis |

Spans use zero-based UTF-16 offsets into the original source. Repeated occurrences remain separate. Reads before assignments and assignments in only one branch remain possible external dependencies. A variable being read does not mean its value must always be present.

Counter seed dependencies, loop-carried assignments, control transfers, and shared includes currently produce conservative analysis with partial coverage. These cases need fixed-point summaries before stronger claims are possible.

## Partials and streaming

`render` accepts `with value as name` and `for collection as item`, including named arguments and `forloop` metadata. A render loop reuses its isolated child state across items. `include` supports `with value`, binding it under the template name while sharing caller state. Project analysis maps these bindings to caller paths (including `items[*].title`); project checking passes item types to the callee. Shared include flow summaries remain partial.

Prefer an explicit `as` name for `render … for`. The pinned LiquidJS release binds omitted aliases under the literal key `undefined`; this engine preserves that behavior. `include … for` and interpolated filenames remain unsupported.

`for … offset:continue` resumes a cursor keyed by loop variable and collection source syntax. Includes share cursors; isolated renders get fresh cursors. The cursor advances by the selected slice length even when the body breaks early, matching LiquidJS. Empty-collection `else` tests the input before offset/limit slicing.


```ts
import { Effect, Layer, Stream } from "effect"
import * as Liquid from "effect-liquid/Liquid"
import * as Render from "effect-liquid/Render"
import * as Loader from "effect-liquid/TemplateLoader"

const services = Layer.merge(
  Render.layer({ strictVariables: true }),
  Loader.memory({ card: "{{ person.name }}" })
)

const program = Effect.gen(function* () {
  const document = yield* Liquid.parse('{% render "card", person: user %}')
  const dependencies = yield* Liquid.analyzeProject(document)
  const chunks = yield* Stream.runCollect(
    Liquid.renderStream(document, { user: { name: "Ada" } })
  )
  return { dependencies, output: Array.from(chunks).join("") }
}).pipe(Effect.provide(services))
```

`render` isolates partial locals; `include` shares the caller's assignment frame. Named arguments are supported. `with`/`for`/`as`, interpolated filenames, and `offset:continue` are not implemented and are rejected.

Project analysis loads literal dependencies, maps render parameters to caller inputs, reports missing isolated arguments, and bounds cycles and document counts. Shared include summaries and dynamic targets report partial coverage. There is no implicit network loader or persistent cache.

`effect-liquid/node` exports `fileLoader(root, extension?)`, requiring Effect platform `FileSystem` and `Path` layers. It canonicalizes paths and confines resolved templates to the configured root, including symlinks.

Streams produce chunks on demand, preserve order, and clean up interrupted extensions. An error may follow already-emitted output. Captures buffer their bodies. Default limits are 1,000,000 evaluation steps, 100,000 loop iterations, 64 partial levels, and 10,000,000 generated UTF-8 bytes; captured content counts when generated and again when output. Parsing defaults to 1,000,000 source code units, 100,000 template tokens, and depth 128 (hard ceiling 256). Normalization bounds input depth, node count, and total string length.

## Check a document

```ts
import { Effect } from "effect"
import * as Liquid from "effect-liquid/Liquid"
import * as Type from "effect-liquid/Type"

const result = await Effect.runPromise(Effect.gen(function* () {
  const document = yield* Liquid.parse("{{ user.nmae }}")
  return yield* Liquid.check(document, Type.record({
    user: Type.record({ name: Type.string })
  }))
}))
// result.passed === false; diagnostics include UnknownProperty
```

The checker handles records, optional fields, arrays, tuples, unions, local bindings, basic truthiness guards, and filter signatures. Strict mode is the default; `{ mode: "compatibility" }` relaxes selected coercion and presence findings. Unknown filter signatures and unresolved control/dependency analysis remain visible. Strict checks cannot pass with partial coverage.

Filter signatures can declare `positionalArguments`, such as `["number", "boolean"]` for `divided_by`. Each entry overrides the shared `argument` type for that position; `"any"` permits any type. Argument diagnostics point to the individual argument expression.

`checkProject(document, contract, { contracts: { card: cardContract } })` checks literal render dependencies and explicit callee contracts. It reports mismatched arguments at the call and references the callee. Without an explicit callee contract, it derives one from supplied argument types. Shared include contracts and cyclic/dynamic calls remain partial.

The checker is a conservative initial implementation, not a complete Liquid type system. It does not prove termination, successful I/O, or the behavior of trusted custom filter implementations.

## Effect Schema

```ts
import { Effect, Schema } from "effect"
import * as Liquid from "effect-liquid/Liquid"
import { fromSchema, decode } from "effect-liquid/Schema"

const Context = Schema.Struct({ user: Schema.Struct({ name: Schema.String }) })
const program = Effect.gen(function* () {
  const { type } = yield* fromSchema(Context)
  const document = yield* Liquid.parse("{{ user.name }}")
  const checked = yield* Liquid.check(document, type)
  const data = yield* decode(Context, { user: { name: "Ada" } })
  return { checked, output: yield* Liquid.render(document, data) }
}).pipe(Effect.provide(Liquid.layer))
```

Projection uses decoded shapes and never executes refinement predicates or transformation handlers. Recursive and opaque schemas produce explicit unknowns. Runtime validation is a separate Effect operation; checking a template does not validate actual data.

## Effectful filters

```ts
import { Effect } from "effect"
import * as Builtins from "effect-liquid/Builtins"
import * as Filter from "effect-liquid/Filter"

const filters = Filter.add(Builtins.registry, "greet", {
  run: (value) => Effect.succeed(`Hello, ${value}`),
  signature: { input: "any", output: "string", minArgs: 0, maxArgs: 0 }
})
// Liquid.render(document, context, filters)
```

Composing registries preserves extension error and service types. Expected errors become located `FilterFailure<E>` values; defects and interruption remain distinct. The same filter runs in buffered and streaming renders. Custom tag registration is deferred.

## CLI

After `pnpm build`:

```sh
node dist/cli.js analyze template.liquid
node dist/cli.js render template.liquid --context data.json
node dist/cli.js check template.liquid --contract contract.json
printf '{{ user.name }}' | node dist/cli.js analyze -
```

Output is JSON. Exit codes: 0 success, 1 findings or operation failure, 2 invalid command usage. Contracts are serialized `Type` values, for example `{"_tag":"Record","fields":{"name":{"_tag":"String"}}}`. The CLI currently handles local documents; compose project loaders through the library API.

## Remaining work

Full filter/tag/options parity, custom tags, cache invalidation, precise include and loop summaries, broader checker narrowing/coercion rules, and project CLI support remain in [PLAN.md](./PLAN.md). [SPEC.md](./SPEC.md) records the target architecture and implementation adjustments. Release publication and package licensing have not been configured.

## Upstream conformance

`pnpm conformance` compares the checked-in upstream corpus against LiquidJS and effect-liquid, including exact output and error behavior. `pnpm conformance:check` gates changes against explicit known gaps; `pnpm conformance:strict` requires complete agreement with both the oracle and supplied upstream expectations. These are correctness checks without timing measurements.

Fixtures come from pinned LiquidJS, Deepin ruby-liquid, Shopify Liquid, and Shopify liquid-spec sources. [Conformance documentation](conformance/README.md) explains reports, adding cases, regenerating imports, exclusions, and [attribution](conformance/NOTICE.md). Passing the baseline gate is not a claim of full compatibility.
