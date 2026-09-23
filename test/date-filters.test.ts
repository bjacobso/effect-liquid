import { Effect, Either } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

describe("date filters", () => {
  it.each([
    "{{ '2020-06-15 14:30:45' | date: '%Y-%m-%d %H:%M:%S' }}",
    "{{ '2020-03-01' | date: '%A %j %U %W' }}",
    "{{ 1152098955 | date: '%Y-%m-%d' }}",
    "{{ '2020-06-15' | date: '%-d %_d %0d %#B' }}",
    "{{ '2020-06-15' | date_to_string: 'ordinal', 'US' }}",
    "{{ 'invalid' | date: '%Y' }}",
  ])("matches pinned date behavior for %s", async (source) => {
    expect(await run(source)).toBe(
      await new Reference({ timezoneOffset: 0 }).parseAndRender(source),
    );
  });
  it("exposes date output to the checker", async () => {
    const document = await Effect.runPromise(Liquid.parse("{{ timestamp | date: '%Y' | upcase }}"));
    const result = await Effect.runPromise(
      Liquid.check(document, Type.record({ timestamp: Type.string })),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UnknownCoverage");
  });
  it.each([
    '{{ "1990-12-31T23:00:00Z" | date: "%Y-%m-%dT%H:%M:%S %z %s", 360 }}',
    '{{ "1990-12-31T23:00:00Z" | date: "%Y-%m-%dT%H:%M:%S %Z", "Asia/Colombo" }}',
    '{{ "2021-01-01T23:00:00Z" | date: "%Y-%m-%dT%H:%M:%S %z", "America/New_York" }}',
    '{{ "2021-06-01T23:00:00Z" | date: "%Y-%m-%dT%H:%M:%S %z", "America/New_York" }}',
    '{{ "2022-12-08T03:22:18.000Z" | date: nil, "America/Cayman" }}',
  ])("formats the requested timezone for %s", async (source) => {
    expect(await run(source)).toBe(
      await new Reference({ timezoneOffset: 0 }).parseAndRender(source),
    );
  });
  it("reports an invalid timezone as a located filter error", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(
          Liquid.parse('{{ "2021-01-01" | date: "%Y", "Invalid/Timezone" }}'),
          (document) => Liquid.render(document, {}),
        ).pipe(Effect.provide(Liquid.layer)),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result))
      expect(result.left).toMatchObject({ _tag: "FilterFailure", name: "date" });
  });
});
