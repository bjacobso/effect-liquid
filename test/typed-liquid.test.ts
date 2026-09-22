import { Effect } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";
import { liquid } from "../src/TypedLiquid.js";

type Context = {
  user: { name: string; active: boolean };
  products: readonly { title: string }[];
};

const L = liquid<Context>();
const greeting = L.template`
{% if ${L.path("user.active")} %}
  Hello, {{ ${L.path("user.name").upcase().escape()} }}!
{% endif %}`;

it("renders typed expression holes as ordinary Liquid", async () => {
  const context: Context = { user: { name: "Ada", active: true }, products: [] };
  expect(greeting.source).toContain("user.name | upcase | escape");
  expect(await Effect.runPromise(greeting.render(context).pipe(Effect.provide(Liquid.layer)))).toBe(
    await new Reference().parseAndRender(greeting.source, context),
  );
  const result = await Effect.runPromise(
    greeting.check(
      Type.record({
        user: Type.record({ name: Type.string, active: Type.boolean }),
        products: Type.array(Type.record({ title: Type.string })),
      }),
    ),
  );
  expect(result.diagnostics).toEqual([]);
});

it("rejects untyped template holes at runtime", () => {
  expect(() =>
    L.template(["{{ ", " }}"] as unknown as TemplateStringsArray, "user.name" as never),
  ).toThrow("typed expressions");
});

it("checks raw Liquid text against an explicit contract", async () => {
  const typo = L.template`{{ user.nmae }}`;
  const result = await Effect.runPromise(
    typo.check(Type.record({ user: Type.record({ name: Type.string }) })),
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UnknownProperty");
});

function typeChecks() {
  L.path("products").size();
  // @ts-expect-error Unknown context path
  L.path("user.nmae");
  // @ts-expect-error A boolean cannot be uppercased
  L.path("user.active").upcase();
  // @ts-expect-error Template holes require typed expressions
  L.template`{{ ${"user.name"} }}`;
  // @ts-expect-error Required product data is missing
  greeting.render({ user: { name: "Ada", active: true } });
}
void typeChecks;
