import { Context, Data, Effect, Either, Fiber, Layer, Ref, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as Builtins from "../src/Builtins.js";
import * as Filter from "../src/Filter.js";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import { location, make } from "../src/Source.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (
  source: string,
  context: unknown = {},
  config: Partial<Render.Config> = {},
  templates: Record<string, string> = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Liquid.render(yield* Liquid.parse(source), context);
    }).pipe(Effect.provide(Layer.merge(Render.layer(config), Loader.memory(templates)))),
  );
const analysis = (s: string) => Effect.runPromise(Effect.flatMap(Liquid.parse(s), Liquid.analyze));
const check = (s: string, contract: Type.Type) =>
  Effect.runPromise(Effect.flatMap(Liquid.parse(s), (d) => Liquid.check(d, contract)));
describe("syntax and rendering", () => {
  it("renders the README example", async () =>
    expect(await run("Hello, {{ user.name | upcase }}!", { user: { name: "Ada" } })).toBe(
      "Hello, ADA!",
    ));
  it("leaves arbitrary text alone", async () =>
    expect(await run('<a title="unfinished> x')).toBe('<a title="unfinished> x'));
  it("trims whitespace while preserving quoted delimiters", async () =>
    expect(await run(' a \n {{- "}}" -}} \n b')).toBe(" a}}b"));
  it("ignores raw/comment expressions", async () =>
    expect(await run("{% raw %}{{ ignored }}{% endraw %}{% comment %}{{{% endcomment %}")).toBe(
      "{{ ignored }}",
    ));
  it("uses Liquid truthiness and right-associative logic", async () =>
    expect(
      await run(
        "{% if z %}T{% endif %}{% if s %}T{% endif %}{% if false and true or true %}X{% else %}F{% endif %}",
        { z: 0, s: "" },
      ),
    ).toBe("TTF"));
  it("supports assignment capture case loops and control flow", async () =>
    expect(
      await run(
        '{% assign x = 1 %}{% capture title %}X{{x}}{% endcapture %}{% case title %}{% when "X1" %}yes{% else %}no{% endcase %}{% for p in (1..5) %}{% if p == 2 %}{% continue %}{% endif %}{{p}}{% if p == 3 %}{% break %}{% endif %}{% endfor %}',
      ),
    ).toBe("yes13"));
  it("restores shadowed loop bindings and exposes assignments", async () =>
    expect(
      await run("{% assign p = 9 %}{% for p in (1..2) %}{% assign p = 4 %}{{p}}{% endfor %}{{p}}"),
    ).toBe("124"));
  it("handles default allow_false", async () =>
    expect(
      await run('{{ false | default: "x", allow_false: true }}|{{ false | default: "x" }}'),
    ).toBe("false|x"));
  it("isolates render arguments from parent variables", async () =>
    expect(
      await run(
        '{% assign x = "parent" %}{% render "p", y: x %}{{x}}',
        {},
        {},
        { p: '{{x}}/{{y}}{% assign x = "child" %}' },
      ),
    ).toBe("/parentparent"));
  it("shares assignment context for include", async () =>
    expect(
      await run(
        '{% assign x = "parent" %}{% include "p" %}{{x}}',
        {},
        {},
        { p: '{{x}}{% assign x = "child" %}' },
      ),
    ).toBe("parentchild"));
  it.each([
    "{{",
    "{% if x %}",
    "{% for x in xs %}{% endif %}",
    "{{ x + y }}",
    "{% unknown %}",
    "{% break %}",
    "{{ x | upcase junk }}",
    "{% if x %}{% else %}{% else %}{% endif %}",
  ])("rejects malformed/unsupported syntax %s", async (s) =>
    expect(Either.isLeft(await Effect.runPromise(Effect.either(Liquid.parse(s))))).toBe(true),
  );
  it("reports UTF-16 source locations", async () => {
    const d = await Effect.runPromise(Liquid.parse(make("😀\r\n{{ user.name }}", "a")));
    const a = await Effect.runPromise(Liquid.analyze(d));
    expect(a.occurrences[0]?.span).toEqual({ sourceId: "a", start: 7, end: 16 });
    expect(location(d.source, 7)).toEqual({ line: 2, column: 4 });
  });
  it("rejects strict missing values and unknown filters", async () => {
    await expect(run("{{ x }}", {}, { strictVariables: true })).rejects.toThrow("Missing variable");
    await expect(run("{{ x | missing }}")).rejects.toThrow("Unknown filter");
    expect(await run('{{ "x" | missing }}', {}, { strictFilters: false })).toBe("x");
  });
  it("rejects cycles and accessors without invoking them", async () => {
    let called = false;
    await expect(
      run("{{x}}", {
        get x() {
          called = true;
          return 1;
        },
      }),
    ).rejects.toThrow("Accessors");
    expect(called).toBe(false);
    const context: Record<string, unknown> = {};
    context.x = context;
    await expect(run("{{x}}", context)).rejects.toThrow("Cyclic");
  });
  it("bounds range, iteration, output, recursion, and parser work", async () => {
    await expect(
      run("{% for x in (1..100) %}x{% endfor %}", {}, { maxIterations: 10 }),
    ).rejects.toThrow("Range limit");
    await expect(run("😀😀", {}, { maxOutputBytes: 7 })).rejects.toThrow("Output limit");
    await expect(
      run('{% render "p" %}', {}, { maxDepth: 2 }, { p: '{% render "p" %}' }),
    ).rejects.toThrow("recursion");
    expect(
      Either.isLeft(
        await Effect.runPromise(Effect.either(Liquid.parse("1234", { maxSourceLength: 3 }))),
      ),
    ).toBe(true);
  });
});
describe("analysis", () => {
  it("collects computed indices and filter arguments", async () => {
    const a = await analysis("{{ user.name | default: fallback }} {{ a[b.c].d }}");
    expect(a.externalRoots).toEqual(["user", "fallback", "a", "b"]);
    expect(a.externalPaths).toContain("a[b.c].d");
  });
  it("tracks aliases and loop element provenance", async () => {
    const a = await analysis(
      "{% assign heading = user.name %}{% for p in products %}{{p.title}}{{heading}}{% endfor %}",
    );
    expect(a.externalRoots).toEqual(["user", "products"]);
    expect(a.derivedInputPaths).toContain("products[*].title");
    expect(a.derivedInputPaths).toContain("user.name");
  });
  it("keeps before-write and conditional dependencies", async () => {
    expect(
      (await analysis("{{x}}{% assign x = 1 %}{{x}}")).occurrences.map((o) => o.external),
    ).toEqual([true, false]);
    expect(
      (await analysis("{% if flag %}{% assign x = 1 %}{% endif %}{{x}}")).externalRoots,
    ).toEqual(["flag", "x"]);
    expect(
      (await analysis("{% for p in ps %}{% assign x = 1 %}{% endfor %}{{x}}")).externalRoots,
    ).toEqual(["ps", "x"]);
  });
  it("joins definite writes across branches", async () =>
    expect(
      (
        await analysis(
          "{% if flag %}{% assign x = 1 %}{% else %}{% assign x = 2 %}{% endif %}{{x}}",
        )
      ).externalRoots,
    ).toEqual(["flag"]));
  it("retains occurrences and excludes raw", async () => {
    const a = await analysis("{{x}}{{x}}{% raw %}{{y}}{% endraw %}");
    expect(a.occurrences).toHaveLength(2);
    expect(a.externalRoots).toEqual(["x"]);
  });
  it("marks unvisited dependencies partial", async () =>
    expect((await analysis("{% render target %}")).coverage).toBe("partial"));
});
describe("checking", () => {
  const contract = Type.record({
    user: Type.record({
      name: Type.string,
      address: Type.optional(Type.record({ city: Type.string })),
    }),
    products: Type.array(Type.record({ title: Type.string })),
  });
  it("finds misspelled properties", async () => {
    const result = await check("{{ user.nmae }}", contract);
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "UnknownProperty")).toBe(true);
  });
  it("checks loop item properties", async () => {
    expect((await check("{% for p in products %}{{ p.title }}{% endfor %}", contract)).passed).toBe(
      true,
    );
    expect((await check("{% for p in products %}{{ p.titel }}{% endfor %}", contract)).passed).toBe(
      false,
    );
  });
  it("requires an optional guard", async () => {
    expect((await check("{{ user.address.city }}", contract)).passed).toBe(false);
    expect(
      (await check("{% if user.address %}{{ user.address.city }}{% endif %}", contract)).passed,
    ).toBe(true);
  });
  it("reports unknown filter coverage without executing handlers", async () => {
    const result = await check("{{user.name | mystery}}", contract);
    expect(result.coverage).toBe("partial");
    expect(result.passed).toBe(false);
  });
  it("checks filter arguments and arity", async () => {
    expect((await check('{{ 1 | plus: "abc" }}', contract)).passed).toBe(false);
    expect((await check("{{ 1 | plus }}", contract)).passed).toBe(false);
  });
});
describe("Effect extensions and streams", () => {
  class Prefix extends Context.Tag("test/Prefix")<Prefix, string>() {}
  class Failure extends Data.TaggedError("Failure")<Record<never, never>> {}
  const registry = Filter.add(Builtins.registry, "prefix", {
    run: (value) => Effect.map(Prefix, (p) => p + value),
  });
  it("retains service requirements through registry and renderer", async () => {
    const program = Effect.gen(function* () {
      const d = yield* Liquid.parse('{{ "world" | prefix }}');
      return yield* Liquid.render(d, {}, registry);
    }).pipe(Effect.provide(Liquid.layer));
    expectTypeOf<Effect.Effect.Context<typeof program>>().toEqualTypeOf<Prefix>();
    const typed: Effect.Effect<string, Effect.Effect.Error<typeof program>, Prefix> = program;
    expect(await Effect.runPromise(typed.pipe(Effect.provideService(Prefix, "hello ")))).toBe(
      "hello world",
    );
  });
  it("wraps typed extension failures with the source span", async () => {
    const reg = Filter.add(Builtins.registry, "fail", { run: () => Effect.fail(new Failure()) });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.either(Liquid.render(yield* Liquid.parse("{{ 1 | fail }}"), {}, reg));
      }).pipe(Effect.provide(Liquid.layer)),
    );
    expect(
      Either.isLeft(result) && result.left._tag === "FilterFailure" && result.left.cause._tag,
    ).toBe("Failure");
  });
  it("pulls in order and stops before later effects", async () => {
    let count = 0;
    const reg = Filter.add(Builtins.registry, "count", { run: () => Effect.sync(() => ++count) });
    const d = await Effect.runPromise(Liquid.parse("{{ 0 | count }}{{ 0 | count }}"));
    const output = await Effect.runPromise(
      Stream.runCollect(Liquid.renderStream(d, {}, reg).pipe(Stream.take(1))).pipe(
        Effect.provide(Liquid.layer),
      ),
    );
    expect(Array.from(output)).toEqual(["1"]);
    expect(count).toBe(1);
  });
  it("finalizes interrupted extensions", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const released = yield* Ref.make(false);
        const reg = Filter.add(Builtins.registry, "wait", {
          run: () => Effect.never.pipe(Effect.ensuring(Ref.set(released, true))),
        });
        const d = yield* Liquid.parse("{{ 0 | wait }}");
        const fiber = yield* Effect.fork(Liquid.render(d, {}, reg));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        return yield* Ref.get(released);
      }).pipe(Effect.provide(Liquid.layer)),
    );
    expect(result).toBe(true);
  });
  it("keeps repeated and concurrent renders isolated", async () => {
    const d = await Effect.runPromise(Liquid.parse("{% assign x = x | plus: 1 %}{{x}}"));
    const values = await Effect.runPromise(
      Effect.all([Liquid.render(d, { x: 1 }), Liquid.render(d, { x: 10 })], {
        concurrency: "unbounded",
      }).pipe(Effect.provide(Liquid.layer)),
    );
    expect(values).toEqual(["2", "11"]);
  });
});
it("keeps CRLF locations one-based even inside the newline", () => {
  const source = make("a\r\nb");
  expect(location(source, 2)).toEqual({ line: 1, column: 3 });
  expect(location(source, 3)).toEqual({ line: 2, column: 1 });
});
