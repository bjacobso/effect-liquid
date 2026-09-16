import { Effect, Either } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

it.each([
  [2.5, 0, "3"],
  [-2.5, 0, "-3"],
  [1.005, 2, "1.01"],
  [-1.005, 2, "-1.01"],
  [9.075, 2, "9.08"],
  [-9.075, 2, "-9.08"],
  [-125, -1, "-130"],
  [1e-7, 8, "1e-7"],
  [-0.1, 0, "0"],
] as const)("rounds %s to precision %s as %s", async (value, precision, expected) => {
  const source = "{{ value | round: precision }}";
  const context = { value, precision };
  expect(await run(source, context)).toBe(expected);
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});

it("matches rounding coercion and fractional precision without truncating the precision", async () => {
  const source = "{{ value | round: precision }}";
  const oracle = new Reference();
  for (const value of [null, false, "junk", "2.675tail", 123, 0.49999999999999994, 1e21])
    for (const precision of [-2, 0, 1.5, 2]) {
      const context = { value, precision };
      expect(await run(source, context)).toBe(await oracle.parseAndRender(source, context));
    }
});

it("coerces whole numeric strings, booleans, nil, and arrays consistently across arithmetic", async () => {
  const oracle = new Reference();
  for (const operation of [
    "plus: 2",
    "minus: 2",
    "times: 2",
    "modulo: 3",
    "at_least: 2",
    "at_most: 2",
    "abs",
    "ceil",
    "floor",
  ])
    for (const value of [null, true, false, "5tail", "0x10", " 2.5 ", [], [2], [2, 3], {}]) {
      const source = `{{ value | ${operation} }}`;
      expect(await run(source, { value })).toBe(await oracle.parseAndRender(source, { value }));
    }
});

it("floors integer division when the flag coerces to a nonzero number", async () => {
  const source = "{{ value | divided_by: divisor, integer }}";
  const oracle = new Reference();
  for (const value of [5, -5, "5tail"])
    for (const divisor of [3, -3])
      for (const integer of [true, false, 0, 1, "1", 2, "true", "false", null]) {
        const context = { value, divisor, integer };
        expect(await run(source, context)).toBe(await oracle.parseAndRender(source, context));
      }
  expect(await run("{{ -5 | divided_by: 3, true }}")).toBe("-2");
  expect(await run("{{ 5 | divided_by: 3 }}")).toBe("1.6666666666666667");
});

it("rejects non-finite rounding and division results at the Liquid value boundary", async () => {
  for (const source of [
    "{{ 1 | divided_by: 0 }}",
    "{{ 1 | round: 400 }}",
    "{{ 1 | round: -400 }}",
  ]) {
    const result = await Effect.runPromise(
      Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc)).pipe(
        Effect.provide(Liquid.layer),
        Effect.either,
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe("RenderError");
  }
});

it("checks numeric divisors and boolean division flags at their own argument spans", async () => {
  const check = (source: string) =>
    Effect.runPromise(
      Effect.flatMap(Liquid.parse(source), (doc) => Liquid.check(doc, Type.record({}))),
    );
  expect((await check("{{ 5 | divided_by: 3, true }}")).diagnostics).toEqual([]);
  for (const [source, bad] of [
    ['{{ 5 | divided_by: "three", true }}', '"three"'],
    ['{{ 5 | divided_by: 3, "true" }}', '"true"'],
    ['{{ 5 | plus: "bad" }}', '"bad"'],
  ]) {
    const result = await check(source!);
    const diagnostic = result.diagnostics.find((item) => item.code === "FilterArgument");
    expect(diagnostic).toBeDefined();
    expect(source!.slice(diagnostic!.span.start, diagnostic!.span.end)).toBe(bad);
  }
  expect(
    (await check("{{ 5 | divided_by: 3, true, 0 }}")).diagnostics.some(
      (d) => d.code === "FilterArity",
    ),
  ).toBe(true);
});
