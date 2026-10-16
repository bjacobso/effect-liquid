import { Effect, Layer } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as T from "../src/Type.js";

const run = (
  source: string,
  context: object = {},
  templates: Record<string, string> = {},
  dialect: Liquid.Dialect = "ruby",
) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, { dialect }), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );

describe("Ruby include bindings", () => {
  it("iterates implicit and explicit aliases, preserves caller forloop, and restores shadowed names", async () => {
    const templates = { p: "{{p}}/{{item}}/{{forloop.index}};" };
    expect(
      await run("{% include tpl for items %}", { tpl: "p", items: ["a", "b"] }, templates),
    ).toBe("a//;b//;");
    expect(
      await run(
        "{% for i in (1..2) %}{% include 'p' for items as item %}{% endfor %}{{item}}",
        { items: ["a", "b"], item: "outer" },
        templates,
      ),
    ).toBe("/a/1;/b/1;/a/2;/b/2;outer");
    expect(await run("{% include 'p' with user as item %}", { user: "Ada" }, templates)).toBe(
      "/Ada/;",
    );
  });
  it("shares assignments, skips empty loads, and propagates loop control", async () => {
    expect(
      await run(
        "{% include 'p' for items %}{{n}}",
        { items: [1, 2, 3] },
        { p: "{% assign n = n | default: 0 | plus: 1 %}" },
      ),
    ).toBe("3");
    expect(await run("{% include 'missing' for items %}", { items: [] })).toBe("");
    expect(
      await run(
        "{% for i in (1..2) %}{% include 'p' for items as item %}{{i}}{% endfor %}",
        { items: ["a", "b"] },
        { p: "{% if item == 'b' %}{% break %}{% endif %}{{item}}" },
      ),
    ).toBe("a");
  });
  it("maps aliases to element paths and checks child argument types without inventing include forloop", async () => {
    const doc = await Effect.runPromise(
      Liquid.parse("{% include 'p' for items as item %}", { dialect: "ruby" }),
    );
    const loader = Loader.memory({ p: "{{item.name}}/{{forloop.index}}" });
    const analysis = await Effect.runPromise(
      Liquid.analyzeProject(doc).pipe(Effect.provide(loader)),
    );
    expect(analysis.externalPaths).toContain("items[*].name");
    expect(analysis.externalPaths).toContain("forloop.index");
    const checked = await Effect.runPromise(
      Liquid.checkProject(doc, T.record({ items: T.array(T.number) })).pipe(Effect.provide(loader)),
    );
    expect(checked.diagnostics.some((d) => d.code === "InvalidReceiver")).toBe(true);
    expect(checked.coverage).toBe("partial");
  });
});

it("keeps Ruby raw interior whitespace and early closing behavior as explicit dialect choices", async () => {
  expect(await run("> {%- raw -%} inner {%- endraw -%} <")).toBe("> inner <");
  const early = "{% raw %} Foobar {% invalid {% {% endraw {% endraw %}";
  expect(await run(early)).toBe(" Foobar {% invalid {% {% endraw ");
  await expect(
    new Reference().parseAndRender("> {%- raw -%} inner {%- endraw -%} <"),
  ).rejects.toThrow("not closed");
});

it.each([
  "{% comment %}{% raw %}hello{% endcomment %}",
  "{% comment %}this is {{{ not }}} valid{{ liquid{% endcomment %}",
])("lexically rejects a malformed comment body: %s", async (source) => {
  expect(await Effect.runPromise(Effect.isFailure(Liquid.parse(source, { dialect: "ruby" })))).toBe(
    true,
  );
  expect(() => new Reference().parse(source)).toThrow();
});
it("scans raw inside comments without interpreting ignored expressions or unknown tags", async () => {
  const source =
    "{% comment %}{% raw %}{% endcomment %}{{ignored}}{% endraw %}{% unknown x %}{% endcomment %}OK";
  expect(await run(source)).toBe("OK");
  const analysis = await Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, { dialect: "ruby" }), Liquid.analyze),
  );
  expect(analysis.occurrences).toEqual([]);
  expect(
    await Effect.runPromise(Effect.isFailure(Liquid.parse(source, { maxSourceLength: 10 }))),
  ).toBe(true);
});
it.each(["nil", "xs", "'oops'"])("matches pinned nonnumeric tablerow cols %s", async (cols) => {
  const source = `{% tablerow i in (1..2) cols:${cols} %}{{i}}{% endtablerow %}`;
  const context = { xs: [1, 2] };
  expect(await run(source, context, {}, "liquidjs")).toBe(
    await new Reference().parseAndRender(source, context),
  );
});
it("matches pinned boolean cycles and distinguishes nil from missing slice length", async () => {
  for (const source of [
    "{% cycle true, false %}{% cycle true, false %}",
    "{{'abc' | slice: 1, nil}}",
    "{{'abc' | slice: 1, missing}}",
  ])
    expect(await run(source, {}, {}, "liquidjs")).toBe(
      await new Reference().parseAndRender(source),
    );
});

it("includes scalar records once and passes their record type to child checking", async () => {
  const source = "{% include 'p' for product as item %}";
  const context = { product: { title: "Widget" } };
  expect(await run(source, context, { p: "{{item.title}}" })).toBe("Widget");
  expect(
    await run(
      "{% include tpl for product %}",
      { ...context, tpl: "product" },
      { product: "{{product.title}}" },
    ),
  ).toBe("Widget");
  const doc = await Effect.runPromise(Liquid.parse(source, { dialect: "ruby" }));
  const checked = await Effect.runPromise(
    Liquid.checkProject(doc, T.record({ product: T.record({ title: T.string }) }), {
      mode: "compatibility",
    }).pipe(Effect.provide(Loader.memory({ p: "{{item.title}}" }))),
  );
  expect(checked.passed).toBe(true);
  expect(checked.diagnostics.every((d) => d.code === "UnknownCoverage")).toBe(true);
});
