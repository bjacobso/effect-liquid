import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: unknown = {}, templates: Record<string, string> = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );

describe("counter and cycle compatibility", () => {
  it("keeps counters separate from assignment while honoring numeric input", async () => {
    const source = "{% assign n = 99 %}{% increment n %}|{{n}}|{% decrement n %}|{{n}}";
    const context = { n: 5 };
    expect(await run(source, context)).toBe("5|99|5|99");
    expect(context).toEqual({ n: 5 });
    expect(await run("{% decrement n %}|{% increment n %}|{{n}}")).toBe("-1|-1|0");
  });
  it("resets state between renders and stream subscriptions", async () => {
    const doc = await Effect.runPromise(Liquid.parse('{% increment n %}{% cycle "a", "b" %}'));
    const stream = Liquid.renderStream(doc).pipe(
      Stream.provideLayer(Layer.merge(Render.layer(), Loader.memory({}))),
    );
    const consume = () => Effect.runPromise(Stream.runFold(stream, "", (a, b) => a + b));
    expect(await Promise.all([consume(), consume()])).toEqual(["0a", "0a"]);
  });
  it("isolates render registers and shares include registers", async () => {
    const templates = { p: '{% increment n %}{% cycle "a", "b" %}' };
    const source =
      '{% increment n %}{% cycle "a", "b" %}{% include "p" %}{% render "p" %}{% increment n %}{% cycle "a", "b" %}';
    const expected = await new Reference({ templates }).parseAndRender(source);
    expect(expected).toBe("0a1b0a2a");
    expect(await run(source, {}, templates)).toBe(expected);
  });
  it("groups by evaluated group and candidate syntax, evaluating only the selected value", async () => {
    const source =
      '{% cycle group: "a", missing %}{% cycle "x": "a", missing %}{% cycle "x": "c", "d" %}';
    expect(await run(source, { group: "x" })).toBe("ac");
    const strict = Effect.flatMap(Liquid.parse('{% cycle "a", missing %}'), (doc) =>
      Liquid.render(doc),
    ).pipe(Effect.provide(Layer.merge(Render.layer({ strictVariables: true }), Loader.memory({}))));
    expect(await Effect.runPromise(strict)).toBe("a");
  });
  it("accepts a trailing comma in cycle values", async () => {
    const source =
      '{%- cycle "1", "2", -%}{%- cycle "1", "2", -%}{%- cycle "1", "2", -%}{%- cycle "1", -%}';
    expect(await run(source)).toBe(await new Reference().parseAndRender(source));
  });
  it.each(["{% cycle %}", '{% cycle "group": %}', "{% increment %}", '{% decrement "n" %}'])(
    "rejects malformed state tag %s",
    async (source) => {
      expect(await Effect.runPromise(Effect.isFailure(Liquid.parse(source)))).toBe(true);
    },
  );
  it("extracts cycle inputs and recognizes counter bindings without erasing assignments", async () => {
    const doc = await Effect.runPromise(
      Liquid.parse(
        '{% increment n %}{{n}}{% cycle group: first, second %}{% assign n = "label" %}{% increment n %}{{n}}',
      ),
    );
    const result = await Effect.runPromise(Liquid.analyze(doc));
    expect([...result.externalRoots].sort()).toEqual(["first", "group", "n", "second"]);
    const seed = result.occurrences.find((occurrence) => occurrence.path === "n");
    expect(doc.source.text.slice(seed!.span.start, seed!.span.end)).toBe("n");
    expect(result.coverage).toBe("partial");
    expect(result.bindings.some((binding) => binding.kind === "counter")).toBe(true);
    const checked = await Effect.runPromise(
      Liquid.check(
        doc,
        Type.record({ group: Type.string, first: Type.string, second: Type.string }),
      ),
    );
    expect(checked.diagnostics).toEqual([]);
  });
});

describe("tag argument compatibility", () => {
  it("accepts an empty echo tag", async () => {
    const source = "before{% echo %}after";
    expect(await run(source)).toBe(await new Reference().parseAndRender(source));
  });
  it("accepts quoted capture names", async () => {
    const source =
      "{% capture \"form_classes\" %}wide{% endcapture %}{{ form_classes }}{% capture 'other' %}x{% endcapture %}{{ other }}";
    expect(await run(source)).toBe(await new Reference().parseAndRender(source));
  });
  it("accepts comma-separated for options", async () => {
    const source = "{% for i in items, limit: 2, offset: 1 %}{{ i }}{% endfor %}";
    const context = { items: [1, 2, 3, 4] };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
    expect(
      await Effect.runPromise(Effect.isFailure(Liquid.parse("{% for i in items, %}{% endfor %}"))),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        Effect.isFailure(Liquid.parse("{% for i in items,, limit: 2 %}{% endfor %}")),
      ),
    ).toBe(true);
  });
});

describe("range compatibility", () => {
  it("treats missing or nonnumeric endpoints as empty ranges", async () => {
    const source = "{% for item in (a..3) %}{{ item }}{% else %}empty{% endfor %}";
    for (const context of [{}, { a: "not a number" }])
      expect(await run(source, context)).toBe(
        await new Reference().parseAndRender(source, context),
      );
  });
  it("preserves fractional range endpoints", async () => {
    const source = "{% for item in (a..b) %}{{ item }},{% endfor %}";
    const context = { a: 1.5, b: 3 };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  });
});

describe("filter argument compatibility", () => {
  it.each([
    '{{ "test" | append: "x", | upcase: }}',
    '{{ "test" | append: "x" | upcase: }}',
    '{{ "hello" | append: "world", }}',
    '{{ "hello" | append: "1", | append: "2", }}',
  ])("accepts empty or trailing filter argument slots in %s", async (source) => {
    expect(await run(source)).toBe(await new Reference().parseAndRender(source));
  });
});

describe("property compatibility", () => {
  it("reads question-mark property names as data keys", async () => {
    const source = "{{ d.respond_to? }}|{% if a.empty? %}yes{% endif %}";
    const context = { d: { "respond_to?": "owned" }, a: { "empty?": true } };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  });
});

describe("array filters", () => {
  it("supports stable natural and numeric sorting without mutating input", async () => {
    const items = [{ name: "b", n: 2 }, { name: "A", n: 10 }, { name: "a", n: 1 }, { n: 0 }];
    const before = structuredClone(items);
    expect(await run('{{ items | sort_natural: "name" | map: "n" | join: "," }}', { items })).toBe(
      "10,1,2,0",
    );
    expect(await run('{{ items | sort: "n" | map: "n" | join: "," }}', { items })).toBe("0,1,2,10");
    expect(items).toEqual(before);
  });
  it("coerces scalar and nil inputs and preserves false in compact", async () => {
    expect(
      await run('{{ nil | concat: list | compact | uniq | join: "," }}|{{ 4 | reverse | first }}', {
        list: [null, false, 0, 0, ""],
      }),
    ).toBe("false,0,|4");
    expect(await run('{{ "a,b,,," | split: "," | join: ":" }}|{{ nil | split: "," | size }}')).toBe(
      "a:b|0",
    );
    expect(await run('{{ "abc" | first }}{{ "abc" | last }}')).toBe("ac");
  });
  it("supports nested mapping, matching, searching, and numeric coercion", async () => {
    const items = [
      { meta: { active: false, cost: "2.5" } },
      { meta: { active: 0, cost: 3 } },
      { meta: { active: true, cost: "bad" } },
    ];
    expect(
      await run(
        '{{ items | where: "meta.active" | map: "meta.cost" | join: "," }}|{{ items | sum: "meta.cost" }}',
        { items },
      ),
    ).toBe("3,bad|5.5");
    expect(
      await run(
        '{{ items | find_index: "meta.active", false }}|{{ items | has: "meta.active", true }}',
        { items },
      ),
    ).toBe("0|true");
    expect(await run('{{ "123" | to_integer | json }}')).toBe("123");
  });
  it("supports nonmutating sequence operations and negative slices", async () => {
    const values = [1, 2, 3];
    expect(
      await run(
        '{{ values | push: 4 | shift | unshift: 0 | pop | join: "," }}|{{ values | slice: -2, 1 | first }}|{{ values | slice: -9 | size }}',
        { values },
      ),
    ).toBe("0,2,3|2|0");
    expect(values).toEqual([1, 2, 3]);
  });
});
