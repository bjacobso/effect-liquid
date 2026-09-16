import { Effect, Either } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, value: unknown) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, { value })).pipe(
      Effect.provide(Liquid.layer),
    ),
  );
it("formats empty, singleton, pair, and longer arrays with pinned coercion", async () => {
  const oracle = new Reference();
  for (const value of [
    [],
    ["a"],
    ["a", "b"],
    ["a", "b", "c"],
    ["a", null, "c"],
    [
      [1, 2],
      [3, 4],
    ],
    [false, {}, 3],
  ])
    for (const argument of ["", ': "or"', ": nil", ": false", ': ""']) {
      const source = `{{ value | array_to_sentence_string${argument} }}`;
      expect(await run(source, value)).toBe(await oracle.parseAndRender(source, { value }));
    }
  expect(await run("{{value|array_to_sentence_string}}", ["a", "b", "c"])).toBe("a, b, and c");
});
it("reports typed failures for non-arrays and omitted append/prepend arguments", async () => {
  for (const [source, value] of [
    ["{{value|array_to_sentence_string}}", null],
    ["{{value|array_to_sentence_string}}", "abc"],
    ["{{value|append}}", "a"],
    ["{{value|prepend}}", "a"],
  ] as const) {
    const doc = await Effect.runPromise(Liquid.parse(source));
    const result = await Effect.runPromise(
      Effect.either(Liquid.render(doc, { value }).pipe(Effect.provide(Liquid.layer))),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("FilterFailure");
      if (result.left._tag === "FilterFailure")
        expect(result.left.cause._tag).toBe("BuiltinFilterError");
    }
    await expect(new Reference().parseAndRender(source, { value })).rejects.toThrow();
  }
});
it("distinguishes omitted arguments from explicit nil for concatenation", async () => {
  expect(await run("{{value|append:nil}}|{{value|prepend:nil}}", "abc")).toBe("abc|abc");
});
it("checks array inputs and string outputs without executing the filter", async () => {
  const doc = await Effect.runPromise(Liquid.parse("{{value|array_to_sentence_string|upcase}}"));
  expect(
    (await Effect.runPromise(Liquid.check(doc, Type.record({ value: Type.array(Type.string) }))))
      .diagnostics,
  ).toEqual([]);
  expect(
    (
      await Effect.runPromise(Liquid.check(doc, Type.record({ value: Type.string })))
    ).diagnostics.some((d) => d.code === "FilterInput"),
  ).toBe(true);
});

it("preserves singleton element types through subsequent filters", async () => {
  const oracle = new Reference();
  for (const value of [[123], [false], [null], [{}], [[1, 2]]]) {
    const source = "{{value|array_to_sentence_string|json}}";
    expect(await run(source, value)).toBe(await oracle.parseAndRender(source, { value }));
  }
  const doc = await Effect.runPromise(Liquid.parse("{{value|array_to_sentence_string|plus:1}}"));
  expect(
    (await Effect.runPromise(Liquid.check(doc, Type.record({ value: Type.tuple(Type.number) }))))
      .diagnostics,
  ).toEqual([]);
});
