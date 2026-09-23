import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (
  source: string,
  context: unknown = {},
  templates: Record<string, string> = {},
  config: Partial<Render.Config> = {},
) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(config), Loader.memory(templates))),
    ),
  );
const oracle = (source: string, context: object = {}, templates: Record<string, string> = {}) =>
  new Reference({ templates }).parseAndRender(source, structuredClone(context));

describe("loop continuation", () => {
  it("continues by collection syntax and variable name, using the selected length even after break", async () => {
    const source =
      "{% for x in items limit:2 %}{{x}}{% break %}{% endfor %}|{% for x in items offset:continue limit:2 %}{{x}}{% endfor %}|{% for y in items offset:continue limit:1 %}{{y}}{% endfor %}|{% for x in other offset:continue limit:1 %}{{x}}{% endfor %}";
    const context = { items: [1, 2, 3, 4, 5], other: [8, 9] };
    expect(await run(source, context)).toBe("1|34|1|8");
    expect(await oracle(source, context)).toBe("1|34|1|8");
  });
  it("handles negative slicing and only runs else for an initially empty collection", async () => {
    const source =
      "{% for x in items offset:-3 limit:-1 %}{{x}}{% endfor %}|{% for x in items offset:99 %}X{% else %}EMPTY{% endfor %}|{% for x in nil %}X{% else %}EMPTY{% endfor %}";
    expect(await run(source, { items: [1, 2, 3, 4] })).toBe("23||EMPTY");
    expect(await oracle(source, { items: [1, 2, 3, 4] })).toBe("23||EMPTY");
  });
  it("shares cursors through include, isolates render, and never treats continue as an input", async () => {
    const source =
      '{% for x in items limit:1 %}{{x}}{% endfor %}{% include "p" %}{% render "p", items: items %}';
    const templates = { p: "{% for x in items offset:continue limit:1 %}{{x}}{% endfor %}" };
    expect(await run(source, { items: [1, 2, 3] }, templates)).toBe("121");
    const analysis = await Effect.runPromise(
      Effect.flatMap(Liquid.parse(templates.p), Liquid.analyze),
    );
    expect(analysis.externalRoots).toEqual(["items"]);
  });
});

describe("partial bindings", () => {
  it("supports with aliases, implicit template-name binding, and shared include", async () => {
    const context = { user: { name: "Ada" }, parent: "P" };
    const templates = { card: "{{card.name}}/{{person.name}}/{{parent}};" };
    const source =
      '{% render "card" with user as person %}{% render "card" with user %}{% include "card" with user %}';
    expect(await run(source, context, templates)).toBe("/Ada/;Ada//;Ada//P;");
    expect(await run(source, context, templates)).toBe(await oracle(source, context, templates));
  });
  it("combines with, for, and named arguments and preserves child state across iterations", async () => {
    const source =
      '{% render "p" for items as item with "!" as suffix, prefix: ">" %}|{{saved}}{% increment n %}';
    const templates = {
      p: '{{prefix}}{{item}}{{suffix}}/{{forloop.index}}{% increment n %}{% cycle "a", "b" %}{% assign saved = item %}',
    };
    const context = { items: ["A", "B"] };
    expect(await run(source, context, templates)).toBe(await oracle(source, context, templates));
    expect(await run(source, context, templates)).toBe(">A!/10a>B!/21b|0");
  });
  it("overwrites each item binding while preserving other assignments, without seeding counters from parameters", async () => {
    const templates = { p: '{{item}}{% assign item = "changed" %}{% increment n %}' };
    const source = '{% render "p" for items as item, n: 99 %}';
    expect(await run(source, { items: ["a", "b"] }, templates)).toBe("a0b1");
    expect(await oracle(source, { items: ["a", "b"] }, templates)).toBe("a0b1");
  });
  it("handles scalar iterations, empty collections, and the pinned omitted-alias behavior", async () => {
    const templates = { p: "{{undefined}}/{{forloop.index}}" };
    expect(await run('{% render "p" for "one" %}', {}, templates)).toBe("one/1");
    expect(await run('{% render "missing" for items as item %}', { items: [] })).toBe("");
    expect(await run('{% render "p" for "one" %}', {}, templates)).toBe(
      await oracle('{% render "p" for "one" %}', {}, templates),
    );
  });
  it("bounds partial iteration and supports replay after an interrupted stream", async () => {
    const source = '{% render "p" for items as item %}';
    const templates = { p: "{{item}}" };
    await expect(
      run(source, { items: [1, 2, 3] }, templates, { maxIterations: 1 }),
    ).rejects.toThrow("Iteration limit");
    const doc = await Effect.runPromise(Liquid.parse(source));
    const stream = Liquid.renderStream(doc, { items: [1, 2, 3] }).pipe(
      Stream.provideLayer(Layer.merge(Render.layer(), Loader.memory(templates))),
    );
    await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1)));
    expect(await Effect.runPromise(Stream.runFold(stream, "", (a, b) => a + b))).toBe("123");
  });
  it("maps project inputs through object and item bindings and checks child item types", async () => {
    const source = '{% render "card" with user as person %}{% render "row" for items as item %}';
    const templates = { card: "{{person.name}}", row: "{{item.title}}/{{forloop.index}}" };
    const doc = await Effect.runPromise(Liquid.parse(source));
    const analysis = await Effect.runPromise(
      Liquid.analyzeProject(doc).pipe(Effect.provide(Loader.memory(templates))),
    );
    expect(analysis.externalPaths).toContain("user.name");
    expect(analysis.externalPaths).toContain("items[*].title");
    expect(analysis.diagnostics).toEqual([]);
    const checked = await Effect.runPromise(
      Liquid.checkProject(
        doc,
        Type.record({
          user: Type.record({ name: Type.string }),
          items: Type.array(Type.record({ title: Type.string })),
        }),
      ).pipe(Effect.provide(Loader.memory(templates))),
    );
    expect(checked.passed).toBe(true);
    expect(checked.diagnostics).toEqual([]);
  });
  it.each([
    '{% render "p" with %}',
    '{% render "p" for items as %}',
    '{% render "p" with one with two %}',
    '{% include "p" for items as item %}',
  ])("rejects malformed or unsupported binding %s", async (source) => {
    expect(await Effect.runPromise(Effect.isFailure(Liquid.parse(source)))).toBe(true);
  });
});

describe("interrupts outside loops", () => {
  it.each(["break", "continue"])("stops the current template on %s", async (tag) => {
    const source = `before{% ${tag} %}after`;
    expect(await run(source)).toBe("before");
    expect(await run(source)).toBe(await oracle(source));
  });

  it.each(["break", "continue"])("isolates %s inside render", async (tag) => {
    const source = '{% for i in (1..3) %}{{ i }}{% render "p" %}{{ i }}{% endfor %}';
    const templates = { p: `X{% ${tag} %}Y` };
    expect(await run(source, {}, templates)).toBe("1X12X23X3");
    expect(await run(source, {}, templates)).toBe(await oracle(source, {}, templates));
  });

  it.each([
    ["break", "1X"],
    ["continue", "1X2X3X"],
  ])("propagates %s through include", async (tag, expected) => {
    const source = '{% for i in (1..3) %}{{ i }}{% include "p" %}{{ i }}{% endfor %}';
    const templates = { p: `X{% ${tag} %}Y` };
    expect(await run(source, {}, templates)).toBe(expected);
    expect(await run(source, {}, templates)).toBe(await oracle(source, {}, templates));
  });

  it("accepts break in tablerow bodies", async () => {
    const source = "{% tablerow item in items cols:2 %}{{ item }}{% break %}{% endtablerow %}";
    const context = { items: ["a", "b"] };
    expect(await run(source, context)).toBe(await oracle(source, context));
  });
});

it("treats prototype-named aliases as own data in dependency maps", async () => {
  const source = '{% render "p" with user as __proto__ %}';
  const doc = await Effect.runPromise(Liquid.parse(source));
  const result = await Effect.runPromise(Liquid.analyze(doc));
  const args = result.dependencies[0]!.args;
  expect(Object.getPrototypeOf(args)).toBe(null);
  expect(Object.hasOwn(args, "__proto__")).toBe(true);
  expect(await run(source, { user: { name: "Ada" } }, { p: "{{__proto__.name}}" })).toBe("Ada");
});
