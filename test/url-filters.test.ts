import { Effect, Either, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, expectTypeOf, it } from "vitest";
import type { BuiltinFilterError } from "../src/Diagnostic.js";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const render = (source: string, context: object = {}) =>
  Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
    Effect.provide(Liquid.layer),
  );
const run = (source: string, context: object = {}) => Effect.runPromise(render(source, context));
it("distinguishes component, CGI, and URI escaping", async () => {
  const source = "{{ value | url_encode }}|{{ value | cgi_escape }}|{{ value | uri_escape }}";
  const context = { value: "a b!'()*[]:/" };
  expect(await run(source, context)).toBe(
    "a+b!'()*%5B%5D%3A%2F|a+b%21%27%28%29%2A%5B%5D%3A%2F|a%20b!'()*[]:/",
  );
});
it("uses the pinned decode ordering for escaped plus signs", async () => {
  expect(await run('{{ "a%2Bb+c" | url_decode }}')).toBe("a b c");
  expect(await run('{{ "你好 😀" | url_encode | url_decode }}')).toBe("你好 😀");
  expect(await run("{{ nil | url_encode }}|{{ 12 | uri_escape }}")).toBe("|12");
});
it.each(["%", "%GG", "%C3%28"])(
  "returns a located typed failure for malformed encoding %s",
  async (value) => {
    const source = "prefix {{ value | url_decode }}";
    const program = render(source, { value });
    type Failure = Effect.Effect.Error<typeof program>;
    expectTypeOf<
      Extract<Failure, { readonly _tag: "FilterFailure" }>["cause"]
    >().toEqualTypeOf<BuiltinFilterError>();
    const result = await Effect.runPromise(Effect.either(program));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result) && result.left._tag === "FilterFailure") {
      expect(result.left.name).toBe("url_decode");
      expect(result.left.cause._tag).toBe("BuiltinFilterError");
      expect(result.left.cause.message).toContain("URI");
      expect(source.slice(result.left.span.start, result.left.span.end)).toContain("url_decode");
    } else throw new Error("Expected a filter failure");
  },
);
it.each(["url_encode", "cgi_escape", "uri_escape"])(
  "handles malformed UTF-16 in %s without a defect",
  async (filter) => {
    const result = await Effect.runPromise(
      Effect.either(render(`{{ value | ${filter} }}`, { value: "\ud800" })),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("FilterFailure");
  },
);
it.each(["default", "raw", "pretty", "ascii", "latin", "none", "unknown"])(
  "matches pinned slugify mode %s",
  async (mode) => {
    const source = "{{ value | slugify: mode }}|{{ value | slugify: mode, true }}";
    const context = { value: " -- The cönfig_É.œ file! -- ", mode };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  },
);
it("has no shared slugification state and strips only the pinned boundary hyphens", async () => {
  const source = '{{ "--Hello  World--" | slugify: "raw" }}';
  expect(await run(source)).toBe("-hello-world-");
  expect(await run(source)).toBe("-hello-world-");
});
it("retains typed errors through streaming after an emitted prefix", async () => {
  const doc = await Effect.runPromise(Liquid.parse("before{{ value | url_decode }}"));
  const result = await Effect.runPromise(
    Effect.either(
      Stream.runCollect(Liquid.renderStream(doc, { value: "%" })).pipe(
        Effect.provide(Liquid.layer),
      ),
    ),
  );
  expect(Either.isLeft(result) && result.left._tag).toBe("FilterFailure");
});
it("provides checker metadata and extracts slug arguments", async () => {
  const doc = await Effect.runPromise(Liquid.parse("{{ title | slugify: mode | url_encode }}"));
  const analysis = await Effect.runPromise(Liquid.analyze(doc));
  expect([...analysis.externalRoots].sort()).toEqual(["mode", "title"]);
  const checked = await Effect.runPromise(
    Liquid.check(doc, Type.record({ title: Type.string, mode: Type.string })),
  );
  expect(checked.diagnostics).toEqual([]);
});
