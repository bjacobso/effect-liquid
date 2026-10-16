import { runInNewContext } from "node:vm";
import { Effect, Layer, Stream } from "effect";
import { build } from "esbuild";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

const run = (source: string, config: Partial<Render.Config> = {}, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(config), Loader.memory())),
    ),
  );

describe("date configuration", () => {
  it.each([
    { timezoneOffset: 360 },
    { timezoneOffset: "America/New_York" },
    { preserveTimezones: true, timezoneOffset: 600 },
    { timezoneOffset: -330, dateFormat: "%d%q of %b %Y at %I:%M %P" },
    { locale: "zh-CN", timezoneOffset: "Asia/Shanghai" },
  ])("uses options consistently across date aliases: %j", async (config) => {
    const oracle = new Reference(config);
    for (const filter of [
      "date",
      "date_to_xmlschema",
      "date_to_rfc822",
      "date_to_string",
      "date_to_long_string",
    ])
      for (const input of ["2024-07-31T20:24:00+02:30", "1990-12-31T23:00:00Z", "invalid"])
        expect(await run(`{{ '${input}' | ${filter} }}`, config)).toBe(
          await oracle.parseAndRender(`{{ '${input}' | ${filter} }}`),
        );
  });
  it("lets explicit timezone arguments override preservation and keeps the original epoch", async () => {
    const config = { preserveTimezones: true, timezoneOffset: 360 };
    for (const timezone of ["'Asia/Colombo'", "-330", "nil", "missing"]) {
      const source = `{{ '1990-12-31T23:00:00+02:30' | date: '%Y-%m-%d %H:%M %z %:Z %s', ${timezone} }}`;
      expect(await run(source, config)).toBe(await new Reference(config).parseAndRender(source));
    }
  });
  it("handles DST, fractional-hour zones, and positive/negative preserved offsets", async () => {
    for (const input of [
      "2024-01-01T12:00:00Z",
      "2024-07-01T12:00:00Z",
      "2024-07-01T12:00:00-01:00",
      "2024-07-01T12:00:00+05:45",
    ])
      for (const config of [
        { timezoneOffset: "America/New_York" },
        { timezoneOffset: "Asia/Kathmandu" },
        { preserveTimezones: true },
      ]) {
        const source = `{{ '${input}' | date: '%a %A %b %B %Y-%m-%d %H:%M %z %Z %s' }}`;
        expect(await run(source, config)).toBe(await new Reference(config).parseAndRender(source));
      }
  });
  it("formats in a browser bundle with Intl and no Node globals", async () => {
    const bundle = await build({
      stdin: {
        contents: `import { Effect } from 'effect'; import { registry } from './src/Builtins.js';
export const run = () => Effect.runPromise(registry.filters.get('date').run('2024-07-31T20:24:00Z', ['%a %b %z'], {}, { missingArguments: [], specialArguments: [], jekyllWhere: false, date: { timezoneOffset: 'Asia/Shanghai', locale: 'zh-CN' } }));`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "dateTest",
      write: false,
    });
    const api = runInNewContext(`${bundle.outputFiles[0]!.text}; dateTest`, {
      Intl,
      TextEncoder,
      TextDecoder,
      URL,
      setTimeout,
      clearTimeout,
    }) as { run: () => Promise<string> };
    expect(await api.run()).toBe("周四 8月 +0800");
  });
});

it("enforces parse length before token allocation and passes the limit to partials", async () => {
  const source = "{% include 'p' %}";
  expect(await Effect.runPromise(Effect.isFailure(Liquid.parse(source, { parseLimit: 10 })))).toBe(
    true,
  );
  const doc = await Effect.runPromise(Liquid.parse(source, { parseLimit: 20 }));
  await expect(
    Effect.runPromise(
      Liquid.render(doc, {}).pipe(
        Effect.provide(Layer.merge(Render.layer(), Loader.memory({ p: "a".repeat(21) }))),
      ),
    ),
  ).rejects.toThrow("Source length limit exceeded");
  expect(await Effect.runPromise(Liquid.parse("", { parseLimit: 0 }))).toMatchObject({ body: [] });
});
it("maps renderLimit to a deterministic work budget and preserves tighter explicit limits", async () => {
  const source = "{% for i in (1..1000) %}{{i}}{% endfor %}";
  await expect(run(source, { renderLimit: 0.01 })).rejects.toThrow("Work limit exceeded");
  expect((await run(source, { renderLimit: 20_000 })).length).toBeGreaterThan(1000);
  await expect(run(source, { renderLimit: 20_000, maxSteps: 1 })).rejects.toThrow(
    "Work limit exceeded",
  );
});
it("checks range, concat growth, and date widths before allocation", async () => {
  await expect(
    run("{% for i in (1..1000000000) %}{% endfor %}", { memoryLimit: 100_000 }),
  ).rejects.toThrow("Range limit exceeded");
  const source =
    "{% for i in (1..count) %}{% assign array = array | concat: array %}{% endfor %}{{array | join}}";
  expect(await run(source, { memoryLimit: 100 }, { array: ["a"], count: 3 })).toBe(
    "a a a a a a a a",
  );
  await expect(run(source, { memoryLimit: 100 }, { array: ["a"], count: 100 })).rejects.toThrow(
    "Memory allocation limit exceeded",
  );
  for (const code of ["d", "N"])
    await expect(
      run(`{{ '2024-01-01' | date: '%5000000${code}' }}`, { memoryLimit: 500 }),
    ).rejects.toThrow("Memory allocation limit exceeded");
  expect((await run("{{ '2024-01-01' | date: '%5000d' }}", { memoryLimit: 10_000 })).length).toBe(
    5000,
  );
  expect(await run("{{ 'abcdef' | slice: 0, 999999999999999999 }}")).toBe("abcdef");
});
it("shares allocation accounting through partials and resets it on stream replay", async () => {
  const doc = await Effect.runPromise(Liquid.parse("{% include 'p' %}{% include 'p' %}"));
  const templates = Loader.memory({ p: "{{ '2024-01-01' | date: '%50d' }}" });
  await expect(
    Effect.runPromise(
      Liquid.render(doc, {}).pipe(
        Effect.provide(Layer.merge(Render.layer({ memoryLimit: 100 }), templates)),
      ),
    ),
  ).rejects.toThrow("Memory allocation limit exceeded");
  const stream = Liquid.renderStream(doc, {}).pipe(
    Stream.provideLayer(Layer.merge(Render.layer({ memoryLimit: 1000 }), templates)),
  );
  for (let i = 0; i < 2; i++)
    expect((await Effect.runPromise(Stream.runFold(stream, "", (a, b) => a + b))).length).toBe(100);
});
it("rejects invalid finite-limit/date options with typed failures", async () => {
  for (const config of [
    { memoryLimit: -1 },
    { renderLimit: Number.NaN },
    { timezoneOffset: Number.POSITIVE_INFINITY },
  ])
    await expect(run("hello", config)).rejects.toThrow("Invalid");
  expect(await Effect.runPromise(Effect.isFailure(Liquid.parse("hello", { parseLimit: -1 })))).toBe(
    true,
  );
});

it("accounts for slice output after string argument coercion", async () => {
  const context = { value: "foobar" };
  expect(await run("{{ value | slice: 0, 1 }}", { memoryLimit: 1 }, context)).toBe("f");
  expect(await run("{{ value | slice: '1', '3' }}", { memoryLimit: 5 }, context)).toBe("oobar");
  await expect(run("{{ value | slice: '1', '3' }}", { memoryLimit: 4 }, context)).rejects.toThrow(
    "Memory allocation limit exceeded",
  );
});
