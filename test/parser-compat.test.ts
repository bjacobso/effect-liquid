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
      const result = await Effect.runPromise(Effect.either(Liquid.parse(source)));
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
