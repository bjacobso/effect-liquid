import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const parse = (source: string) => Liquid.parse(source, { groupedExpressions: true });
const run = (source: string, context: object = {}, templates: Record<string, string> = {}) =>
  Effect.runPromise(
    Effect.flatMap(parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );

it.each([
  ["{% assign x = (name | upcase) %}{{ x }}", "BAR"],
  ['{{ ((name | append: "!") | upcase) }}', "BAR!"],
  ["{% for i in (1..(items | size)) %}{{i}}{% endfor %}", "123"],
  ["{% if (((name | size) > 2) and (1 < 3)) %}yes{% endif %}", "yes"],
  ['{% case (name | upcase) %}{% when ("bar" | upcase) %}yes{% endcase %}', "yes"],
  ["{% unless (name | size) == 0 %}yes{% endunless %}", "yes"],
  ['{% liquid\n assign x = (name | upcase)\n echo (x | append: "!")\n%}', "BAR!"],
  ['{{ "!" | prepend: (name | upcase) }}', "BAR!"],
])("parses grouped expressions in %s", async (source, expected) => {
  const context = { name: "bar", items: [1, 2, 3] };
  expect(await run(source, context)).toBe(expected);
  expect(await run(source, context)).toBe(
    await new Reference({ groupedExpressions: true }).parseAndRender(source, context),
  );
});

it("keeps right-associative conditions while allowing explicit grouping and short-circuiting", async () => {
  expect(
    await run(
      "{% if false and true or true %}yes{% else %}no{% endif %}|{% if (false and true) or true %}yes{% endif %}",
    ),
  ).toBe("no|yes");
  const doc = await Effect.runPromise(parse("{% if true or (missing | upcase) %}yes{% endif %}"));
  expect(
    await Effect.runPromise(
      Liquid.render(doc).pipe(
        Effect.provide(Layer.merge(Render.layer({ strictVariables: true }), Loader.memory({}))),
      ),
    ),
  ).toBe("yes");
});

it("keeps the syntax opt-in and rejects malformed or excessive nesting with typed parse errors", async () => {
  for (const source of ["{{ (x) }}", "{{ (x | upcase) }}"])
    await expect(Effect.runPromise(Liquid.parse(source))).rejects.toThrow("Expected '..'");
  expect(await Effect.runPromise(Liquid.parse("{{ (1..3) }}"))).toBeDefined();
  for (const source of ["{{ () }}", "{{ (x }}", "{{ (x)) }}", "{{ (1..) }}"])
    await expect(Effect.runPromise(parse(source))).rejects.toThrow();
  await expect(
    Effect.runPromise(
      Liquid.parse(`{{ ${"(".repeat(30)}true${")".repeat(30)} }}`, {
        groupedExpressions: true,
        maxDepth: 12,
      }),
    ),
  ).rejects.toThrow("nesting limit");
});

it("preserves variable and type-diagnostic spans inside parentheses", async () => {
  const source = "{{ ((customer.name | upcase)) }}";
  const doc = await Effect.runPromise(parse(source));
  const analysis = await Effect.runPromise(Liquid.analyze(doc));
  expect(analysis.externalPaths).toEqual(["customer.name"]);
  expect(source.slice(analysis.occurrences[0]!.span.start, analysis.occurrences[0]!.span.end)).toBe(
    "customer.name",
  );
  const checked = await Effect.runPromise(
    Liquid.check(doc, Type.record({ customer: Type.record({ name: Type.string }) })),
  );
  expect(checked.diagnostics).toEqual([]);
});

it("propagates syntax through partial rendering, project extraction, and project checks", async () => {
  const doc = await Effect.runPromise(parse('{% render "card", name: (customer.name | upcase) %}'));
  const templates = { card: '{{ (name | append: "!") }}' };
  const services = Layer.merge(Render.layer(), Loader.memory(templates));
  expect(
    await Effect.runPromise(
      Liquid.render(doc, { customer: { name: "bar" } }).pipe(Effect.provide(services)),
    ),
  ).toBe("BAR!");
  const project = await Effect.runPromise(
    Liquid.analyzeProject(doc).pipe(Effect.provide(services)),
  );
  expect(project.documents).toHaveLength(2);
  const checked = await Effect.runPromise(
    Liquid.checkProject(doc, Type.record({ customer: Type.record({ name: Type.string }) })).pipe(
      Effect.provide(services),
    ),
  );
  expect(checked.diagnostics).toEqual([]);
});

it("uses the same syntax for embedded predicates and streaming", async () => {
  const doc = await Effect.runPromise(
    parse(`{{ items | where_exp: 'x', '(x.price | plus: 1) > limit' | size }}`),
  );
  const context = { items: [{ price: 1 }, { price: 5 }], limit: 3 };
  expect(
    await Effect.runPromise(Liquid.render(doc, context).pipe(Effect.provide(Liquid.layer))),
  ).toBe("1");
  const analysis = await Effect.runPromise(Liquid.analyze(doc));
  expect(analysis.externalRoots).toEqual(["items", "limit"]);
  const checked = await Effect.runPromise(
    Liquid.check(
      doc,
      Type.record({ items: Type.array(Type.record({ price: Type.number })), limit: Type.number }),
    ),
  );
  expect(checked.diagnostics).toEqual([]);
  expect(
    await Effect.runPromise(
      Stream.runFold(Liquid.renderStream(doc, context), "", (a, b) => a + b).pipe(
        Effect.provide(Liquid.layer),
      ),
    ),
  ).toBe("1");
});
