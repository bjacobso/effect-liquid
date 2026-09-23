import { Effect } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";
import { lookup } from "../src/Value.js";

const run = (source: string, context: object) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );
it("supports length and size on strings, arrays, and records with own size overrides", async () => {
  const oracle = new Reference();
  for (const value of [
    "😀abc",
    [],
    [1, 2],
    {},
    { a: 1, b: 2 },
    { size: 0, a: 1 },
    { size: null },
    { size: false },
    { size: "custom" },
  ]) {
    const source = "{{ value.length }}|{{ value.size }}";
    expect(await run(source, { value })).toBe(await oracle.parseAndRender(source, { value }));
  }
});
it("resolves property access on literal receivers and analyzes computed keys", async () => {
  const source =
    '{{ nil.foo }}|{{ nil["key"] }}|{{ blank.x }}|{{ empty.size }}|{{ "abc".size }}|{{ nil[key] }}';
  const context = { key: "x" };
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  const analysis = await Effect.runPromise(Effect.flatMap(Liquid.parse(source), Liquid.analyze));
  expect(analysis.externalPaths).toEqual(["key"]);
});
it("distinguishes numeric array indices from string property names and string offsets", async () => {
  const oracle = new Reference();
  for (const value of ["abc", ["a", "b", "c"]])
    for (const key of [-4, -1, 0, 1, 3, 1.5, "-1", "0", "01", "1", "1.0", "+1"]) {
      const source = "{{ value[key] }}";
      expect(await run(source, { value, key }), JSON.stringify({ value, key })).toBe(
        await oracle.parseAndRender(source, { value, key }),
      );
    }
});
it("does not invoke getters or expose prototype keys when reading size", () => {
  let reads = 0;
  const value = {
    get size() {
      reads++;
      return 99;
    },
  };
  expect(lookup(value, "size")).toBeUndefined();
  expect(reads).toBe(0);
  expect(lookup({ constructor: 1 }, "constructor")).toBeUndefined();
});
it("checks lengths and record sizes, including optional own size fields", async () => {
  const doc = await Effect.runPromise(
    Liquid.parse(
      "{{ text.length | plus: 1 }}{{ items.length | plus: 1 }}{{ record.size | plus: 1 }}",
    ),
  );
  expect(
    (
      await Effect.runPromise(
        Liquid.check(
          doc,
          Type.record({
            text: Type.string,
            items: Type.array(Type.number),
            record: Type.record({ a: Type.string }),
          }),
        ),
      )
    ).diagnostics,
  ).toEqual([]);
  const optional = await Effect.runPromise(Liquid.parse("{{ record.size | plus: 1 }}"));
  expect(
    (
      await Effect.runPromise(
        Liquid.check(
          optional,
          Type.record({ record: Type.record({ size: Type.optional(Type.number) }) }),
        ),
      )
    ).diagnostics,
  ).toEqual([]);
  expect(
    (
      await Effect.runPromise(
        Liquid.check(optional, Type.record({ record: Type.record({ size: Type.string }) })),
      )
    ).diagnostics.some((d) => d.code === "FilterInput"),
  ).toBe(true);
});
it("infers the correct tuple element for numeric negative indices and canonical string indices", async () => {
  const doc = await Effect.runPromise(
    Liquid.parse('{{ items[-1] | default: 0 | plus: 1 }}{{ items["0"] | default: "" | upcase }}'),
  );
  expect(
    (
      await Effect.runPromise(
        Liquid.check(doc, Type.record({ items: Type.tuple(Type.string, Type.number) })),
      )
    ).diagnostics,
  ).toEqual([]);
});
it("preserves syntactic dependencies for virtual properties", async () => {
  const doc = await Effect.runPromise(Liquid.parse("{{ text.length }}{{ record.size }}"));
  expect((await Effect.runPromise(Liquid.analyze(doc))).externalPaths).toEqual([
    "text.length",
    "record.size",
  ]);
});
