import { Context, Data, Deferred, Effect, Either, Exit, Fiber, Layer, Stream } from "effect";
import { expect, expectTypeOf, it } from "vitest";
import * as Builtins from "../src/Builtins.js";
import type { BuiltinFilterError } from "../src/Diagnostic.js";
import * as Filter from "../src/Filter.js";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

it("renders 10,000 outputs within a generous scheduling regression budget", async () => {
  const document = await Effect.runPromise(
    Liquid.parse("{% for i in (1..10000) %}{{ i }}{% endfor %}"),
  );
  const expected = Array.from({ length: 10_000 }, (_, i) => String(i + 1)).join("");
  for (const render of [
    Liquid.render(document),
    Stream.runFold(Liquid.renderStream(document), "", (a, b) => a + b),
  ]) {
    const runnable = render.pipe(Effect.provide(Liquid.layer));
    await Effect.runPromise(runnable);
    const start = performance.now();
    const result = await Effect.runPromise(runnable);
    const milliseconds = performance.now() - start;
    expect(result).toBe(expected);
    // Local warm measurements are tens of milliseconds. Allow substantial CI
    // contention while catching the previous ~2-second per-node channel path.
    expect(milliseconds).toBeLessThan(1_000);
  }
});

it("keeps typed filter services and errors in the stream driver", async () => {
  class Suffix extends Context.Tag("test/render-performance/Suffix")<Suffix, string>() {}
  class Rejected extends Data.TaggedError("Rejected")<Record<never, never>> {}
  const registry = Filter.add(Builtins.registry, "suffix", {
    run: (value) =>
      Effect.gen(function* () {
        const suffix = yield* Suffix;
        if (value === 0) return yield* Effect.fail(new Rejected());
        return `${value}${suffix}`;
      }),
  });
  const document = await Effect.runPromise(Liquid.parse("{{ 1 | suffix }}"));
  const stream = Liquid.renderStream(document, {}, registry).pipe(
    Stream.provideSomeLayer(Liquid.layer),
  );
  expectTypeOf<Stream.Stream.Context<typeof stream>>().toEqualTypeOf<Suffix>();
  expectTypeOf<
    Extract<Stream.Stream.Error<typeof stream>, { _tag: "FilterFailure" }>["cause"]
  >().toEqualTypeOf<BuiltinFilterError | Rejected>();
  const output = await Effect.runPromise(
    Stream.runFold(stream, "", (a, b) => a + b).pipe(Effect.provideService(Suffix, "!")),
  );
  expect(output).toBe("1!");
  const failing = await Effect.runPromise(Liquid.parse("prefix{{ 0 | suffix }}"));
  const result = await Effect.runPromise(
    Effect.either(
      Stream.runDrain(Liquid.renderStream(failing, {}, registry)).pipe(
        Effect.provide(Liquid.layer),
        Effect.provideService(Suffix, "!"),
      ),
    ),
  );
  expect(
    Either.isLeft(result) && result.left._tag === "FilterFailure" && result.left.cause._tag,
  ).toBe("Rejected");
});

it("emits a pure prefix before invoking a later filter callback or loader", async () => {
  let calls = 0;
  const registry = Filter.add(Builtins.registry, "later", {
    run: () => {
      calls++;
      return Effect.succeed("later");
    },
  });
  const loader = Layer.succeed(Loader.TemplateLoader, {
    load: () => {
      calls++;
      return Effect.succeed({ id: "partial", text: "later" });
    },
  });
  for (const source of ["prefix{{ 0 | later }}", 'prefix{% render "partial" %}']) {
    const document = await Effect.runPromise(Liquid.parse(source));
    const chunks = await Effect.runPromise(
      Stream.runCollect(Liquid.renderStream(document, {}, registry).pipe(Stream.take(1))).pipe(
        Effect.provide(Layer.merge(Render.layer(), loader)),
      ),
    );
    expect(Array.from(chunks)).toEqual(["prefix"]);
    expect(calls).toBe(0);
  }
});

it("emits prior pure output before a late strict-variable failure", async () => {
  const document = await Effect.runPromise(Liquid.parse("before{{ missing }}"));
  const seen: string[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      Stream.runForEach(Liquid.renderStream(document), (chunk) =>
        Effect.sync(() => {
          seen.push(chunk);
        }),
      ).pipe(Effect.provide(Layer.merge(Render.layer({ strictVariables: true }), Loader.memory()))),
    ),
  );
  expect(seen).toEqual(["before"]);
  expect(Either.isLeft(result) && result.left._tag).toBe("RenderError");
});

it("does not advance effectful producers while a consumer is blocked", async () => {
  let calls = 0;
  const registry = Filter.add(Builtins.registry, "count", {
    run: () => Effect.sync(() => ++calls),
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const document = yield* Liquid.parse("{% for i in (1..10000) %}{{ i | count }}{% endfor %}");
      const consumer = yield* Effect.fork(
        Stream.runForEach(Liquid.renderStream(document, {}, registry), () =>
          Effect.zipRight(Deferred.succeed(received, undefined), Effect.never),
        ),
      );
      yield* Deferred.await(received);
      yield* Effect.yieldNow();
      const produced = calls;
      yield* Fiber.interrupt(consumer);
      return produced;
    }).pipe(Effect.provide(Liquid.layer)),
  );
  expect(result).toBe(1);
});

it.each([false, true])("interrupts empty large loops (stream=%s)", async (stream) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const document = yield* Liquid.parse("{% for i in (1..100000) %}{% endfor %}");
      const render = stream
        ? Stream.runDrain(Liquid.renderStream(document))
        : Liquid.render(document);
      const fiber = yield* Effect.fork(render);
      yield* Effect.yieldNow();
      return yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(Liquid.layer)),
  );
  expect(Exit.isInterrupted(result)).toBe(true);
});

it.each(["ascii", "é", "漢", "😀", "\ud800", "\udc00", "\ud800A\udc00", "\ud800😀"])(
  "counts UTF-8 output exactly for %j",
  async (value) => {
    const document = await Effect.runPromise(
      Liquid.parse("{% capture x %}{{ value }}{% endcapture %}{{ x }}"),
    );
    const bytes = new TextEncoder().encode(value).length * 2;
    for (const stream of [false, true]) {
      const render = stream
        ? Stream.runFold(Liquid.renderStream(document, { value }), "", (a, b) => a + b)
        : Liquid.render(document, { value });
      const provide = (maxOutputBytes: number) =>
        Effect.provide(Layer.merge(Render.layer({ maxOutputBytes }), Loader.memory()));
      expect(await Effect.runPromise(render.pipe(provide(bytes)))).toBe(value);
      const result = await Effect.runPromise(Effect.either(render.pipe(provide(bytes - 1))));
      expect(Either.isLeft(result) && result.left.message).toBe("Output limit exceeded");
    }
  },
);

it.each([false, true])(
  "shares output, work, and iteration limits across partials (stream=%s)",
  async (stream) => {
    const document = await Effect.runPromise(
      Liquid.parse('a{% for j in items limit:1 %}{% endfor %}{% render "partial", items: items %}'),
    );
    const render = stream
      ? Stream.runDrain(Liquid.renderStream(document, { items: [1, 2] }))
      : Liquid.render(document, { items: [1, 2] });
    for (const [config, message] of [
      [{ maxOutputBytes: 2 }, "Output limit exceeded"],
      [{ maxSteps: 10 }, "Work limit exceeded"],
      [{ maxIterations: 1 }, "Iteration limit exceeded"],
    ] as const) {
      const result = await Effect.runPromise(
        Effect.either(
          render.pipe(
            Effect.provide(
              Layer.merge(
                Render.layer(config),
                Loader.memory({ partial: "{% for i in items %}{{ i }}{% endfor %}" }),
              ),
            ),
          ),
        ),
      );
      expect(Either.isLeft(result) && result.left.message).toBe(message);
    }
  },
);

it.each([false, true])(
  "finalizes interrupted filters inside captures and partials (stream=%s)",
  async (stream) => {
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const registry = Filter.add(Builtins.registry, "wait", {
          run: () =>
            Effect.zipRight(Deferred.succeed(started, undefined), Effect.never).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        });
        const document = yield* Liquid.parse('{% render "partial" %}');
        const render = stream
          ? Stream.runDrain(Liquid.renderStream(document, {}, registry))
          : Liquid.render(document, {}, registry);
        const fiber = yield* Effect.fork(render);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      }).pipe(
        Effect.provide(
          Layer.merge(
            Render.layer(),
            Loader.memory({ partial: "{% capture x %}{{ 0 | wait }}{% endcapture %}" }),
          ),
        ),
      ),
    );
    expect(released).toBe(true);
  },
);
