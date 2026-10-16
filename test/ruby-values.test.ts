import { Effect, Stream } from "effect";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as T from "../src/Type.js";
import * as V from "../src/Value.js";
const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, { dialect: "ruby" }), (d) =>
      Liquid.render(d, context),
    ).pipe(Effect.provide(Liquid.layer)),
  );

it("preserves Ruby number kinds and exact decimal accumulation", async () => {
  expect(
    await run("{{0.0}}/{{0}}/{{x}}/{{0.1|plus:0.2}}/{{xs|sum}}", {
      x: V.float(0),
      xs: [V.float("0.1"), V.float("0.2"), V.float("0.3")],
    }),
  ).toBe("0.0/0/0.0/0.3/0.6");
  expect(
    await run(
      "{{5|divided_by:2}}/{{5|divided_by:2.0}}/{{'12abc'|plus:1}}/{{true|plus:1}}/{{ -5|divided_by:2}}",
    ),
  ).toBe("2/2.5/13/1/-3");
  expect(await run("{{x|plus:1}}", { x: V.integer("9007199254740993") })).toBe("9007199254740994");
  expect(await run("{{x|round:2}}/{{x|floor}}/{{x|ceil}}", { x: V.float("-1.235") })).toBe(
    "-1.24/-2/-1",
  );
});
it("coerces large slice lengths and flattens Ruby sum inputs without losing decimal digits", async () => {
  expect(
    await run("{{s|slice:0,n}}/{{xs|sum}}/{{f|sum}}", {
      s: "foobar",
      n: V.integer("9223372036854775808"),
      xs: [1, [2]],
      f: V.float("1234.3838300038383"),
    }),
  ).toBe("foobar/3/1234.3838300038383");
  await expect(run("{{x}}", { x: V.decimal("1e-9999999") })).rejects.toThrow("Invalid Ruby number");
});
it("uses Ruby inspect for coercion and recursive concatenation for output", async () => {
  const context = { h: V.hash([[V.symbol("foo"), "bar"]]), xs: [1, 2], record: { k: "v" } };
  expect(await run("{{h}}|{{xs}}|{{xs|upcase}}|{{record|upcase}}|{{record|size}}", context)).toBe(
    '{:foo=>"bar"}|12|[1, 2]|{"K"=>"V"}|1',
  );
});
it("retains range identity while iterating it and shares stream semantics", async () => {
  const source = "{{(2..4)}}/{% for i in r %}{{i}}{% endfor %}/{{r.size}}/{{r.first}}";
  const document = await Effect.runPromise(Liquid.parse(source, { dialect: "ruby" }));
  const context = { r: V.range(2, 4) };
  const [text, chunks] = await Effect.runPromise(
    Effect.all([
      Liquid.render(document, context),
      Stream.runCollect(Liquid.renderStream(document, context)),
    ]).pipe(Effect.provide(Liquid.layer)),
  );
  expect(text).toBe("2..4/234/3/2");
  expect(Array.from(chunks).join("")).toBe(text);
});
it("rejects incompatible Ruby ordering and distinguishes checker numeric types", async () => {
  expect(await run("{% if 5 > true %}yes{% else %}no{% endif %}")).toBe("no");
  const doc = await Effect.runPromise(
    Liquid.parse("{{0.0}}/{{1}}/{{(2..4)}}", { dialect: "ruby" }),
  );
  const result = await Effect.runPromise(Liquid.check(doc, T.record({})));
  expect(Object.values(result.expressionTypes).map((t) => t._tag)).toContain("Float");
  expect(Object.values(result.expressionTypes).map((t) => t._tag)).toContain("Integer");
  expect(Object.values(result.expressionTypes).map((t) => t._tag)).toContain("Range");
  expect(T.assignable(T.float, T.integer)).toBe(false);
  expect(T.assignable(T.float, T.number)).toBe(true);
  expect(T.isType(T.range())).toBe(true);
});
it("validates encoded inputs and keeps LiquidJS JSON behavior", async () => {
  await expect(run("{{x}}", { x: V.float("NaN") })).rejects.toThrow("Invalid Ruby number");
  expect(
    await Effect.runPromise(
      Effect.flatMap(Liquid.parse("{{h}}/{{0.0}}"), (d) =>
        Liquid.render(d, { h: { k: "v" } }),
      ).pipe(Effect.provide(Liquid.layer)),
    ),
  ).toBe("[object Object]/0");
});
