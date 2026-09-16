# effect-liquid

A planned Liquid template engine built from first principles in TypeScript, with Effect throughout its public operations and runtime. Parse, render, extract variable references, and eventually type-check templates against an explicit data contract.

**Status: design only.** This repository contains the specification and implementation plan; no engine or published package exists yet. Examples below describe the intended API.

## What we are building

- An independent lexer, parser, source-located AST, and interpreter.
- ESM modules with explicit exports, strict TypeScript, and a platform-independent core.
- Effect operations with typed failures, injected services, interruption, and streaming.
- Variable extraction that distinguishes external inputs, local bindings, dynamic lookups, and references through partials.
- A gradual template checker backed by declared context types and filter signatures, with an Effect Schema adapter.

[LiquidJS](https://github.com/harttle/liquidjs) is the behavioral reference and a development-time comparison engine. It will not be a runtime dependency. Template compatibility will grow through a versioned feature matrix; compatibility with LiquidJS's JavaScript API is outside the initial scope.

LiquidJS already provides [experimental static analysis](https://liquidjs.com/tutorials/static-analysis.html). Our design makes analysis a primary consumer of the same AST used by rendering, with explicit uncertainty and a path to type checking.

## Intended usage

Illustrative API, subject to implementation review:

```ts
import { Effect } from "effect"
import * as Liquid from "effect-liquid/Liquid"

const program = Effect.gen(function* () {
  const document = yield* Liquid.parse("Hello, {{ user.name | upcase }}!")
  const analysis = yield* Liquid.analyze(document)
  const output = yield* Liquid.render(document, {
    user: { name: "Ada" }
  })
  return { output, inputs: analysis.externalRoots }
}).pipe(Effect.provide(Liquid.layer))

// At the application boundary:
// Effect.runPromise(program)
// Expected: { output: "Hello, ADA!", inputs: ["user"] }
```

The standard layer supplies built-ins, configuration, and an empty in-memory template loader. Applications can compose a loader for partials and effectful extensions. Library internals never run their own Effect runtime.

## Extracting variables

```liquid
{% assign heading = user.name | upcase %}
{% for product in catalog.products %}
  {{ heading }}: {{ product.title }} {{ labels[locale] }}
{% endfor %}
```

The intended analysis reports:

| Result | Example |
| --- | --- |
| External roots | `user`, `catalog`, `labels`, `locale` |
| External paths | `user.name`, `catalog.products`, `labels[locale]`, `locale` |
| Local bindings | `heading`, `product`; built-in `forloop` inside the loop |
| Local reads | `heading`, `product.title` |
| Derived input access | `product.title` originates from `catalog.products[*].title` |

Every occurrence carries a source span. Dynamic segments remain expressions; the analyzer does not invent a concrete key. An external read means data may be consulted, not that the field must always be present.

## Eventual type checking

Given a contract such as `{ user: { name: string }, products: Array<{ title: string }> }`, the checker should find misspelled properties, invalid filter arguments, and unsafe optional accesses. It should understand assignments, loops, supported guards, and partial parameters.

Checking does not execute templates, loaders other than explicit dependency loading, or custom filters. Unknown types and unresolved dependencies produce visible coverage gaps. A passing check is relative to the declared contract, supported semantics, and trusted extension signatures; it is not a proof that rendering cannot fail.

## Roadmap

1. Lock the compatibility baseline and package conventions.
2. Build the parser, shared AST, and early variable extraction.
3. Implement Liquid semantics and an Effect renderer.
4. Add partials, dependency analysis, streaming, and broader compatibility.
5. Add gradual checking, then Effect Schema integration and tooling.

See [SPEC.md](./SPEC.md) for contracts and decisions, and [PLAN.md](./PLAN.md) for ordered milestones and acceptance criteria.
