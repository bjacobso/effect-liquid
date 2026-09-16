import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import type { ParseOptions } from "../src/Parser.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, options: ParseOptions) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, options), (doc) => Liquid.render(doc, { name: "X" })).pipe(
      Effect.provide(Liquid.layer),
    ),
  );
it("matches independent tag/output trimming in greedy and line-preserving modes", async () => {
  const keys = [
    "trimTagLeft",
    "trimTagRight",
    "trimOutputLeft",
    "trimOutputRight",
    "greedy",
  ] as const;
  for (let mask = 0; mask < 32; mask++) {
    const options = Object.fromEntries(keys.map((key, index) => [key, !!(mask & (1 << index))]));
    const oracle = new Reference(options);
    for (const source of [
      "a \r\n \t{% if true %} \n {{name}} \n {% endif %} \n b",
      "a \n \n {{- name -}} \n \n b",
      "a {% raw %}  {{ name }}  {% endraw %} b",
      "a {% comment %} {{name}} {% endcomment %} b",
      "a\u00a0{{- name -}}\u00a0\n b",
    ])
      expect(await run(source, options), JSON.stringify({ source, options })).toBe(
        await oracle.parseAndRender(source, { name: "X" }),
      );
  }
});
it("preserves CRLF on the left and removes at most one newline on the right when non-greedy", async () => {
  expect(await run("a\r\n \t{{- name -}} \r\n \n b", { greedy: false })).toBe("a\r\nX \n b");
});
it("retains original variable spans and checks the same AST after trimming", async () => {
  const source = " \n {{ name }} \n ";
  const doc = await Effect.runPromise(
    Liquid.parse(source, { trimOutputLeft: true, trimOutputRight: true }),
  );
  const analysis = await Effect.runPromise(Liquid.analyze(doc));
  expect(source.slice(analysis.occurrences[0]!.span.start, analysis.occurrences[0]!.span.end)).toBe(
    "name",
  );
  expect(
    (await Effect.runPromise(Liquid.check(doc, Type.record({ name: Type.string })))).diagnostics,
  ).toEqual([]);
});
it("snapshots options and inherits them through partial rendering and project traversal", async () => {
  const options = { trimOutputLeft: true, trimOutputRight: true };
  const doc = await Effect.runPromise(Liquid.parse('{% render "card", name: name %}', options));
  options.trimOutputLeft = false;
  options.trimOutputRight = false;
  const services = Layer.merge(Render.layer(), Loader.memory({ card: "a \n {{name}} \n b" }));
  expect(
    await Effect.runPromise(Liquid.render(doc, { name: "X" }).pipe(Effect.provide(services))),
  ).toBe("aXb");
  const analysis = await Effect.runPromise(
    Liquid.analyzeProject(doc).pipe(Effect.provide(services)),
  );
  expect(analysis.documents).toHaveLength(2);
  expect(
    (
      await Effect.runPromise(
        Liquid.checkProject(doc, Type.record({ name: Type.string })).pipe(Effect.provide(services)),
      )
    ).diagnostics,
  ).toEqual([]);
  expect(
    await Effect.runPromise(
      Stream.runFold(Liquid.renderStream(doc, { name: "X" }), "", (a, b) => a + b).pipe(
        Effect.provide(services),
      ),
    ),
  ).toBe("aXb");
});
it("rejects non-boolean whitespace options with a typed parse error", async () => {
  const result = await Effect.runPromise(
    Effect.either(Liquid.parse("x", { greedy: "yes" } as unknown as ParseOptions)),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left._tag).toBe("ParseError");
});
