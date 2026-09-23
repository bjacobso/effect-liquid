import { Effect, Either, Fiber } from "effect";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as T from "../src/Type.js";

it("returns typed parse results for a deterministic malformed-input corpus", async () => {
  let seed = 19;
  const alphabet = [
    "{{",
    "}}",
    "{%",
    "%}",
    "[",
    "]",
    "(",
    ")",
    '"',
    "'",
    "if",
    "endfor",
    "|",
    ":",
    "x",
    "\r\n",
    "😀",
  ];
  for (let n = 0; n < 400; n++) {
    let text = "";
    for (let i = 0; i < 30; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    const result = await Effect.runPromise(Effect.either(Liquid.parse(text)));
    if (Either.isLeft(result)) expect(result.left._tag).toBe("ParseError");
  }
});
it("rejects excessive expression nesting with a typed error", async () => {
  const result = await Effect.runPromise(
    Effect.either(Liquid.parse(`{{ x ${"| upcase ".repeat(1000)}}}`)),
  );
  expect(Either.isLeft(result) && result.left.message).toContain("limit exceeded");
});
it("interrupts CPU-heavy render work", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* Liquid.parse("{% for i in (1..100000) %}{{i}}{% endfor %}");
      const fiber = yield* Effect.fork(Liquid.render(d));
      yield* Effect.yieldNow();
      return yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(Liquid.layer)),
  );
  expect(result._tag).toBe("Failure");
});
it("invalidates a guard after direct and branch assignment", async () => {
  const contract = T.record({
    flag: T.boolean,
    user: T.record({ address: T.optional(T.record({ city: T.string })) }),
  });
  for (const assign of [
    "{% assign user = nil %}",
    "{% if flag %}{% assign user = nil %}{% endif %}",
  ]) {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Liquid.check(
          yield* Liquid.parse(`{% if user.address %}${assign}{{user.address.city}}{% endif %}`),
          contract,
        );
      }),
    );
    expect(result.passed).toBe(false);
  }
});
it("does not certify unmodeled loop-carried assignments", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Liquid.check(
        yield* Liquid.parse(
          '{% assign x = 1 %}{% for p in ps %}{{x | plus: 1}}{% assign x = "oops" %}{% endfor %}',
        ),
        T.record({ ps: T.array(T.number) }),
      );
    }),
  );
  expect(result.coverage).toBe("partial");
  expect(result.passed).toBe(false);
});
it("rejects duplicate named arguments explicitly", async () => {
  for (const source of [
    '{% render "p", x: a, x: b %}',
    "{{ x | default: y, allow_false: a, allow_false: b }}",
  ]) {
    const result = await Effect.runPromise(Effect.either(Liquid.parse(source)));
    expect(Either.isLeft(result)).toBe(true);
  }
});
it("rejects non-finite numeric literals", async () => {
  const result = await Effect.runPromise(Effect.either(Liquid.parse(`{{ ${"9".repeat(400)} }}`)));
  expect(Either.isLeft(result) && result.left.message).toBe("Non-finite numeric literal");
});
