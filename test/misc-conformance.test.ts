import { Effect } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

it.each([
  ["{{ value | jsonify }}", { value: "foo" }],
  ["{{ value | inspect }}", { value: "foo" }],
  ["{{ value | inspect }}", { value: { bar: "bar" } }],
  ["{{ value | json: 2 }}", { value: { a: 1 } }],
  ['{{ value | jsonify: "--" }}', { value: [1, 2] }],
  ["{{ missing | inspect }}", {}],
] as const)("matches JSON-style filter output for %s", async (source, context) => {
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});

it.each([
  ["{% for val in string %}{{ forloop.name }}{% endfor %}", { string: "test string" }],
  ["{% for x in (1..2) %}{{ forloop.name }};{% endfor %}", {}],
  ["{% tablerow x in items cols:2 %}{{ tablerowloop.name }}{% endtablerow %}", { items: [1, 2] }],
] as const)("exposes the syntactic loop name for %s", async (source, context) => {
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});

it("checks JSON filter results as strings", async () => {
  const document = await Effect.runPromise(
    Liquid.parse("{{ value | jsonify | upcase }}{{ value | inspect | upcase }}"),
  );
  const result = await Effect.runPromise(
    Liquid.check(document, Type.record({ value: Type.string })),
  );
  expect(result.diagnostics).toEqual([]);
});
