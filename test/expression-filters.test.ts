import { Context, Effect, Either, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Builtins from "../src/Builtins.js";
import * as Filter from "../src/Filter.js";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}, config: Partial<Render.Config> = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(config), Loader.memory({}))),
    ),
  );
it("supports static bracket and dot paths across map, sort, where, and sum", async () => {
  const source = `{{ items | sort: 'meta.rank' | map: 'meta.name' | join: ',' }}|{{ items | where: 'meta["rank"]', 2 | map: 'meta.name' | join }}|{{ items | sum: 'meta.rank' }}`;
  const context = { items: [{ meta: { name: "B", rank: 2 } }, { meta: { name: "A", rank: 1 } }] };
  expect(await run(source, context)).toBe("A,B|B|3");
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  expect(
    await run('{{ values | map: "constructor" | compact | size }}', {
      values: [{ constructor: "blocked" }],
    }),
  ).toBe("0");
});
it("evaluates predicates against item bindings and caller inputs without leaking aliases", async () => {
  const source = `{{ items | where_exp: 'item', 'item.price > threshold and item.available' | map: 'name' | join }}|{{item}}`;
  const context = {
    item: "outer",
    threshold: 10,
    items: [
      { name: "A", price: 12, available: true },
      { name: "B", price: 4, available: true },
      { name: "C", price: 20, available: false },
    ],
  };
  expect(await run(source, context)).toBe("A|outer");
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});
it("preserves exact booleans for where/reject and JS truthiness for searching", async () => {
  const source = `{{ values | where_exp: 'x', 'x' | json }}|{{ values | reject_exp: 'x', 'x' | json }}|{{ values | find_index_exp: 'x', 'x' }}|{{ values | has_exp: 'x', 'x' }}`;
  const context = { values: [0, false, 1, true, null] };
  expect(await run(source, context)).toBe("[true]|[false]|2|true");
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});
it("groups in first-seen order and handles missing keys", async () => {
  const source = `{{ items | group_by_exp: 'item', 'item.kind' | json }}`;
  const context = {
    items: [{ kind: "b", n: 1 }, { kind: "a", n: 2 }, { kind: "b", n: 3 }, { n: 4 }],
  };
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});
it("short-circuits search predicates", async () => {
  expect(
    await run(
      `{{ items | find_exp: 'x', 'x.good or x.missing' | json }}`,
      { items: [{ good: true }, { good: false }] },
      { strictVariables: true },
    ),
  ).toBe('{"good":true}');
});
it("preserves Effect services through registered filters inside predicates", async () => {
  class Threshold extends Context.Tag("test/Threshold")<Threshold, number>() {}
  const registry = Filter.add(Builtins.registry, "above", {
    run: (value) => Effect.map(Threshold, (threshold) => Number(value) > threshold),
    signature: { input: "any", output: "unknown", minArgs: 0, maxArgs: 0 },
  });
  const doc = await Effect.runPromise(
    Liquid.parse(`{{ items | where_exp: 'x', 'x | above' | join: ',' }}`),
  );
  const result = await Effect.runPromise(
    Liquid.render(doc, { items: [1, 3, 5] }, registry).pipe(
      Effect.provide(Liquid.layer),
      Effect.provideService(Threshold, 2),
    ),
  );
  expect(result).toBe("3,5");
});
it("honors native overrides of expression-filter names in rendering and analysis", async () => {
  const registry = Filter.add(Builtins.registry, "where_exp", {
    run: () => Effect.succeed("override"),
  });
  const doc = await Effect.runPromise(
    Liquid.parse(`{{ items | where_exp: 'x', 'broken + predicate' }}`),
  );
  expect(
    await Effect.runPromise(
      Liquid.render(doc, { items: [] }, registry).pipe(Effect.provide(Liquid.layer)),
    ),
  ).toBe("override");
  const analysis = await Effect.runPromise(Liquid.analyze(doc, registry));
  expect(analysis.externalRoots).toEqual(["items"]);
  expect(analysis.coverageReasons).toEqual([]);
});
it("returns typed predicate parse errors at the containing argument", async () => {
  const doc = await Effect.runPromise(Liquid.parse(`{{ items | where_exp: 'x', 'x >' }}`));
  const result = await Effect.runPromise(
    Effect.either(Liquid.render(doc, { items: [1] }).pipe(Effect.provide(Liquid.layer))),
  );
  expect(Either.isLeft(result) && result.left._tag).toBe("FilterFailure");
});
it("bounds nested expressions and iterations, including predicates with empty output", async () => {
  await expect(
    run(`{{ items | where_exp: 'x', 'false' }}`, { items: [1, 2, 3] }, { maxIterations: 1 }),
  ).rejects.toThrow("Iteration limit");
  const expression = `x.children | where_exp: 'x', expression`;
  await expect(
    run(
      `{{ items | where_exp: 'x', expression }}`,
      { expression, items: [{ children: [{ children: [{ children: [] }] }] }] },
      { maxDepth: 2 },
    ),
  ).rejects.toThrow("nesting limit");
});
it("extracts free predicate variables and item provenance with conservative locations", async () => {
  const source = `{{ items | where_exp: 'row', 'row.price > minimum' }}`;
  const doc = await Effect.runPromise(Liquid.parse(source));
  const analysis = await Effect.runPromise(Liquid.analyze(doc));
  expect([...analysis.externalRoots].sort()).toEqual(["items", "minimum"]);
  expect(analysis.derivedInputPaths).toContain("items[*].price");
  expect(analysis.coverage).toBe("partial");
  const read = analysis.occurrences.find((o) => o.path === "minimum")!;
  expect(source.slice(read.span.start, read.span.end)).toBe("'row.price > minimum'");
  const dynamic = await Effect.runPromise(
    Effect.flatMap(Liquid.parse(`{{ items | where_exp: 'row', predicate }}`), Liquid.analyze),
  );
  expect(dynamic.coverageReasons.some((reason) => reason.includes("Dynamic"))).toBe(true);
});
it("checks predicate item types, caller variables, dot map paths, and alias shadowing", async () => {
  const doc = await Effect.runPromise(
    Liquid.parse(
      `{% if row %}{{ items | where_exp: 'row', 'row.price > minimum' | map: 'meta.name' | join }}{% endif %}`,
    ),
  );
  const checked = await Effect.runPromise(
    Liquid.check(
      doc,
      Type.record({
        row: Type.string,
        minimum: Type.number,
        items: Type.array(
          Type.record({ price: Type.number, meta: Type.record({ name: Type.string }) }),
        ),
      }),
    ),
  );
  expect(checked.diagnostics).toEqual([]);
});
it("keeps render state isolated across interrupted subscriptions", async () => {
  const doc = await Effect.runPromise(
    Liquid.parse(`before{{ items | where_exp: 'x', 'x > 1' | join }}{{x}}`),
  );
  const stream = Liquid.renderStream(doc, { items: [1, 2, 3], x: "outer" }).pipe(
    Stream.provideLayer(Liquid.layer),
  );
  await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1)));
  expect(await Effect.runPromise(Stream.runFold(stream, "", (a, b) => a + b))).toBe(
    "before2 3outer",
  );
});

it("charges predicate compilation against the shared work budget", async () => {
  await expect(
    run(
      `{{ items | where_exp: 'x', predicate }}`,
      { items: [1], predicate: `x == "${"a".repeat(100)}"` },
      { maxSteps: 20 },
    ),
  ).rejects.toThrow("Work limit");
});
