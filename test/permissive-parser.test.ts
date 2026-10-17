import { readFileSync } from "node:fs";
import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as T from "../src/Type.js";
const fixtures = (
  JSON.parse(readFileSync("conformance/fixtures/liquid-spec.json", "utf8")) as {
    id: string;
    source: string;
  }[]
).filter((f) => f.id.includes("parser_errors/"));
const templates = { snippet: "P" };
const reference = new Reference({ strictFilters: false, templates });
const services = Layer.merge(Render.layer({ strictFilters: false }), Loader.memory(templates));

it("matches the pinned parser across every imported parser-error fixture", async () => {
  let accepted = 0,
    recovered = 0;
  for (const fixture of fixtures) {
    let expected = true;
    try {
      reference.parse(fixture.source);
    } catch {
      expected = false;
    }
    const result = await Effect.runPromise(Effect.either(Liquid.parse(fixture.source)));
    expect(result._tag === "Right", fixture.id).toBe(expected);
    if (result._tag === "Right") {
      accepted++;
      if (result.right.recovered) recovered++;
    }
    expect(
      await Effect.runPromise(
        Effect.isFailure(Liquid.parse(fixture.source, { dialect: "ruby", errorMode: "strict2" })),
      ),
      fixture.id,
    ).toBe(true);
  }
  expect(accepted).toBe(977);
  expect(recovered).toBe(913);
}, 20000);

it("matches recovered output or render failure across data shapes", async () => {
  for (const fixture of fixtures) {
    const parsed = await Effect.runPromise(Effect.either(Liquid.parse(fixture.source)));
    if (parsed._tag === "Left" || !parsed.right.recovered) continue;
    const native = reference.parse(fixture.source);
    for (const x of ["snippet", 1, false, null, [], [1, 2], {}, undefined]) {
      const context = { ...(x === undefined ? {} : { x }), "?": "Q" };
      let expected: string | undefined;
      try {
        expected = String(await reference.render(native, structuredClone(context)));
      } catch {
        expected = undefined;
      }
      const actual = await Effect.runPromise(
        Effect.either(Liquid.render(parsed.right, structuredClone(context))).pipe(
          Effect.provide(services),
        ),
      );
      expect(actual._tag === "Left" ? undefined : actual.right, `${fixture.id} (${x})`).toBe(
        expected,
      );
    }
  }
}, 30000);

it("keeps recovered syntax partial through local and project tooling, while streams agree", async () => {
  const document = await Effect.runPromise(Liquid.parse("{% assign 42 = 'ok' %}{{['42']}}"));
  expect(document.recovered).toBe(true);
  expect((await Effect.runPromise(Liquid.analyze(document))).coverage).toBe("partial");
  const checked = await Effect.runPromise(Liquid.check(document, T.record({})));
  expect(checked.coverage).toBe("partial");
  expect(checked.passed).toBe(false);
  const text = await Effect.runPromise(Liquid.render(document, {}).pipe(Effect.provide(services)));
  expect(
    Array.from(
      await Effect.runPromise(
        Stream.runCollect(Liquid.renderStream(document, {})).pipe(Effect.provide(services)),
      ),
    ).join(""),
  ).toBe(text);
  const root = await Effect.runPromise(Liquid.parse("{% render 'p' %}"));
  const loader = Loader.memory({ p: "{% assign 42 = 'ok' %}{{['42']}}" });
  expect(
    (await Effect.runPromise(Liquid.analyzeProject(root).pipe(Effect.provide(loader)))).coverage,
  ).toBe("partial");
  expect(
    (await Effect.runPromise(Liquid.checkProject(root, T.record({})).pipe(Effect.provide(loader))))
      .coverage,
  ).toBe("partial");
});
