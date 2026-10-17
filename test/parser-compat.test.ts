import { Effect, Either } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

describe("bare bracket context lookup", () => {
  const context = { name: "Ada", key: "name", user: { age: 4 } };
  it.each([
    '{{ ["name"] }}',
    "{{ [key] }}",
    '{{ ["user"].age }}',
    '{% assign local="hi" %}{{ ["local"] }}',
  ])("matches pinned lookup for %s", async (source) => {
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  });
  it("classifies malformed raw and comment tags as syntax errors", async () => {
    for (const source of ["{% raw foo %}content", "{% comment foo %}content"]) {
      const result = await Effect.runPromise(
        Effect.either(Liquid.parse(source, { dialect: "ruby" })),
      );
      expect(Either.isLeft(result) && result.left._tag).toBe("ParseError");
      if (Either.isLeft(result)) expect(result.left.message).toContain("Invalid");
    }
  });
  it("parses loop control in a for-else branch", async () => {
    const source = "{% for item in items %}{{ item }}{% else %}{% break %}{% endfor %}";
    const document = await Effect.runPromise(Liquid.parse(source));
    expect(document.body[0]?._tag).toBe("For");
  });
  it("reports static roots and dynamic uncertainty", async () => {
    const staticDocument = await Effect.runPromise(Liquid.parse('{{ ["user"].age }}'));
    const analysis = await Effect.runPromise(Liquid.analyze(staticDocument));
    expect(analysis.externalRoots).toContain("user");
    const checked = await Effect.runPromise(
      Liquid.check(staticDocument, Type.record({ user: Type.record({ age: Type.number }) })),
    );
    expect(checked.diagnostics).toEqual([]);
    const dynamicDocument = await Effect.runPromise(Liquid.parse("{{ [key] }}"));
    expect((await Effect.runPromise(Liquid.analyze(dynamicDocument))).coverage).toBe("partial");
  });
});

it.each([
  ["if", "else", "Duplicated else"],
  ["if", "elsif true", "Unexpected elsif after else"],
] as const)("reports invalid %s branch after else", async (tag, extra, message) => {
  const result = await Effect.runPromise(
    Effect.either(Liquid.parse(`{% ${tag} false %}{% else %}{% ${extra} %}{% end${tag} %}`)),
  );
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(result.left.message).toBe(message);
});

it.each(["else", "elsif true"])("ignores later unless %s sections", async (extra) => {
  const source = `{% unless true %}no{% else %}yes{% ${extra} %}no{% endunless %}`;
  expect(await run(source, {})).toBe(await new Reference().parseAndRender(source));
});

// These Shopify liquid-spec parser_errors fixtures require rejection. LiquidJS 10.29.0
// accepts them; the Ruby profile retains strict rejection and recovery has partial static coverage.
it.each([
  ["assign", "{% assign 42 = x %}"],
  ["if", "{% if x == %}{% endif %}"],
  ["cycle", "{% cycle x , , > %}"],
] as const)("rejects malformed %s syntax that LiquidJS parses", async (_tag, source) => {
  expect(() => new Reference().parse(source)).not.toThrow();
  const result = await Effect.runPromise(Effect.either(Liquid.parse(source, { dialect: "ruby" })));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(result.left._tag).toBe("ParseError");
});

it.each([
  "{%comment}{% assign a = 1 %}{%endcomment}{% endif %}",
  "{% #\n{{ foo }}\n %}",
  "{% #\nfirst line\n# second line\n %}",
])("ignores comment content in %s", async (source) => {
  expect(await run(source, {})).toBe(await new Reference().parseAndRender(source));
  const doc = await Effect.runPromise(Liquid.parse(source));
  expect((await Effect.runPromise(Liquid.analyze(doc))).externalRoots).toEqual([]);
  expect((await Effect.runPromise(Liquid.check(doc, Type.record({})))).diagnostics).toEqual([]);
});

it.each(["{{ x.123 }}", "{% for x in contains %}{% endfor %}", "{{ [0] }}"])(
  "rejects Ruby malformed expressions: %s",
  async (source) => {
    expect(
      await Effect.runPromise(Effect.isFailure(Liquid.parse(source, { dialect: "ruby" }))),
    ).toBe(true);
  },
);
it("supports strict2 bare-bracket rejection with partial propagation", async () => {
  expect(
    await Effect.runPromise(
      Effect.isFailure(Liquid.parse("{{['x']}}", { dialect: "ruby", errorMode: "strict2" })),
    ),
  ).toBe(true);
  expect(
    await Effect.runPromise(
      Effect.isFailure(Liquid.parse("{{self['x']}}", { dialect: "ruby", errorMode: "strict2" })),
    ),
  ).toBe(false);
});

it("skips Ruby doc blocks and requires nested comments to close", async () => {
  const d = await Effect.runPromise(
    Liquid.parse("{% doc %}{{ignored}}{% enddoc %}OK", { dialect: "ruby" }),
  );
  expect(await Effect.runPromise(Liquid.render(d, {}).pipe(Effect.provide(Liquid.layer)))).toBe(
    "OK",
  );
  expect(
    await Effect.runPromise(
      Effect.isFailure(
        Liquid.parse("{% comment %}{% comment %}inner{% endcomment %}", { dialect: "ruby" }),
      ),
    ),
  ).toBe(true);
});
