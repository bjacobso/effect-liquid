import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import * as L from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as T from "../src/Type.js";
const run = (source: string, context: object = {}, templates: Record<string, string> = {}) =>
  Effect.runPromise(
    Effect.flatMap(L.parse(source, { dialect: "ruby" }), (d) => L.render(d, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );
it("formats table rows with Ruby newlines in both render modes", async () => {
  const source = "{% tablerow x in xs cols:2 %}{{x}}{% endtablerow %}",
    context = { xs: [1, 2, 3] };
  const d = await Effect.runPromise(L.parse(source, { dialect: "ruby" }));
  const text = await run(source, context);
  expect(text).toBe(
    '<tr class="row1">\n<td class="col1">1</td><td class="col2">2</td></tr>\n<tr class="row2"><td class="col1">3</td></tr>\n',
  );
  expect(
    Array.from(
      await Effect.runPromise(
        Stream.runCollect(L.renderStream(d, context)).pipe(Effect.provide(L.layer)),
      ),
    ).join(""),
  ).toBe(text);
});
it("suppresses blank block text while executing tags and preserving raw literals", async () => {
  expect(await run("{% if true %} \n {% assign x = 3 %} {% endif %}{{x}}")).toBe("3");
  expect(await run("{% for i in (1..2) %} {% raw %} {% endraw %}{% endfor %}")).toBe("    ");
  expect(await run("{% if true %} {% else %}shown{% endif %}")).toBe(" ");
});
it("keeps counters separate from assigns and static input, with visible file values", async () => {
  expect(
    await run("{% increment x %}{{x}}{% assign x = 9 %}{% increment x %}{{x}}", { x: 3 }),
  ).toBe("0119");
  const d = await Effect.runPromise(L.parse("{% increment x %}", { dialect: "ruby" }));
  expect((await Effect.runPromise(L.analyze(d))).externalRoots).toEqual([]);
  expect((await Effect.runPromise(L.check(d, T.record({})))).coverage).toBe("complete");
});
it("shares named cycles across candidate lists and renders repeated when matches", async () => {
  expect(await run('{% cycle "g": "a", "b" %}{% cycle "g": "x", "y" %}')).toBe("ay");
  expect(await run('{% case "a" %}{% when "a", "a" %}x{% endcase %}')).toBe("xx");
});
it("exposes parent loops, implicit render aliases and static environments", async () => {
  expect(
    await run(
      "{% for i in (1..2) %}{% for j in (1..2) %}{{forloop.parentloop.index}}{% endfor %}{% endfor %}",
    ),
  ).toBe("1122");
  expect(
    await run('{% render "item" for items %}', { items: ["a", "b"] }, { item: "{{item}}" }),
  ).toBe("ab");
  const d = await Effect.runPromise(L.parse('{% render "p" %}', { dialect: "ruby" }));
  expect(
    await Effect.runPromise(
      L.render(d, {}).pipe(
        Effect.provide(
          Layer.merge(Render.layer({ globals: { shop: "Ada" } }), Loader.memory({ p: "{{shop}}" })),
        ),
      ),
    ),
  ).toBe("Ada");
});
it("resolves self through ordinary scopes and agrees with static APIs", async () => {
  const source = "{{self['user'].name}}/{% assign key = 'greeting' %}{{self[key]}}";
  expect(await run(source, { user: { name: "Ada" }, greeting: "hi" })).toBe("Ada/hi");
  const d = await Effect.runPromise(L.parse("{{self['user'].name}}", { dialect: "ruby" }));
  expect((await Effect.runPromise(L.analyze(d))).externalPaths).toEqual(["user.name"]);
  expect(
    (await Effect.runPromise(L.check(d, T.record({ user: T.record({ name: T.string }) })))).passed,
  ).toBe(true);
  expect(await run("{% assign self = 'local' %}{{self}}", { self: "outer" })).toBe("local");
});
it("implements Ruby replacements, truncation, escaping and collection selectors", async () => {
  expect(
    await run("{{'ab'|replace:'','-'}}/{{' a  b c '|truncatewords:2}}/{{h|escape}}", {
      h: { k: "v" },
    }),
  ).toBe("-a-b-/a b.../{&quot;k&quot;=&gt;&quot;v&quot;}");
  expect(
    await run("{{items|uniq:'n'|map:'n'|join:','}}/{{s|where:'be'}}", {
      items: [{ n: 1 }, { n: 1 }, { n: 2 }],
      s: ["alpha", "beta"],
    }),
  ).toBe("1,2/beta");
});
it("offers explicit in-memory filesystem matching without changing exact loader defaults", async () => {
  const d = await Effect.runPromise(L.parse("{% render 'CARD' %}", { dialect: "ruby" }));
  expect(
    await Effect.runPromise(
      L.render(d, {}).pipe(
        Effect.provide(
          Layer.merge(
            Render.layer(),
            Loader.memory({ "card.liquid": "yes" }, { extension: ".liquid", caseSensitive: false }),
          ),
        ),
      ),
    ),
  ).toBe("yes");
});

it("keeps self references live in their original render scope and compares their identity", async () => {
  expect(
    await run(
      "{% assign s = self %}{% assign x = 42 %}{{s.x}}/{% render 'p', outer:s %}",
      {},
      { p: "{{outer.x}}/{% assign x = 7 %}{{self.x}}" },
    ),
  ).toBe("42/42/7");
  expect(
    await run("{% assign a=self %}{% assign b=self %}{% if a==b %}yes{% endif %}/{{self|first}}"),
  ).toBe("yes/");
  const d = await Effect.runPromise(L.parse("{% assign s=self %}{{s.x}}", { dialect: "ruby" }));
  expect((await Effect.runPromise(L.analyze(d))).coverage).toBe("partial");
  expect((await Effect.runPromise(L.check(d, T.record({ x: T.integer })))).coverage).toBe(
    "partial",
  );
});
it("tracks dynamic cycle identities, consumes table interrupts and implements ifchanged", async () => {
  expect(await run("{% assign x='a' %}{% cycle x,'b' %}{% cycle x,'b' %}")).toBe("aa");
  expect(
    await run("{% for x in xs %}{% ifchanged %}{{x}}{% endifchanged %}{% endfor %}", {
      xs: [1, 1, 2, 2, 3],
    }),
  ).toBe("123");
  expect(await run("{% tablerow x in (1..3) cols:2 %}{{x}}{% break %}{% endtablerow %}")).toBe(
    '<tr class="row1">\n<td class="col1">1</td></tr>\n',
  );
  expect(await run("{% tablerow x in missing %}x{% endtablerow %}")).toBe("");
});
it("distinguishes command properties from Ruby bracket lookups", async () => {
  expect(
    await run("{{xs.first}}/{{xs['first']}}/{{s.first}}/{{s.size}}/{{i.size}}", {
      xs: [1, 2],
      s: "hello",
      i: 3,
    }),
  ).toBe("1//h/5/8");
  expect(await run("{% include 'p' a:1,b:a %}", {}, { p: "{{a}}-{{b}}" })).toBe("1-1");
});
