import { runInNewContext } from "node:vm";
import { Effect, Layer, Stream } from "effect";
import { build } from "esbuild";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

it.each([
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["你好😀", "5L2g5aW98J+YgA=="],
  ["\u0000a", "AGE="],
  ["\ufeffa", "77u/YQ=="],
])("encodes and decodes UTF-8 text %j", async (plain, encoded) => {
  expect(await run("{{ value | base64_encode }}", { value: plain })).toBe(encoded);
  expect(await run("{{ value | base64_decode }}", { value: encoded })).toBe(plain);
});

it("matches the pinned oracle's permissive decoder and UTF-8 replacement rules", async () => {
  const oracle = new Reference();
  const source = "{{ value | base64_decode }}";
  for (const value of [
    "Z",
    "Zg",
    "Zm8",
    "Z===g",
    "Z! g\n==",
    "Zg==ignored",
    "_w",
    "-w",
    "/w==",
    "wK8=",
    "4oI=",
    "7aCA",
    "8J+YgA==",
    "77u/YQ==",
    "ŁQ==",
    "你好😀",
    "\ud800",
    null,
    false,
    123,
    [1, 2],
    {},
  ]) {
    expect(await run(source, { value }), JSON.stringify(value)).toBe(
      await oracle.parseAndRender(source, { value }),
    );
  }
});

it("coerces inputs and replaces lone UTF-16 surrogates during encoding", async () => {
  const source = "{{ value | base64_encode }}";
  const oracle = new Reference();
  for (const value of [null, true, false, 123, [1, 2], {}, "\ud800", "x\udc00y", "😀"]) {
    expect(await run(source, { value })).toBe(await oracle.parseAndRender(source, { value }));
  }
});

it("round-trips across encoder chunk boundaries without changing concurrent results", async () => {
  const values = ["a".repeat(6143), "b".repeat(6144), "c".repeat(6145), "你好😀".repeat(3000)];
  const source = "{{ value | base64_encode | base64_decode }}";
  expect(await Promise.all(values.map((value) => run(source, { value })))).toEqual(values);
});

it("keeps stream output equivalent and applies the shared output limit", async () => {
  const doc = await Effect.runPromise(Liquid.parse("{{ value | base64_encode }}"));
  expect(
    await Effect.runPromise(
      Stream.runFold(
        Liquid.renderStream(doc, { value: "hello" }),
        "",
        (left, right) => left + right,
      ).pipe(Effect.provide(Liquid.layer)),
    ),
  ).toBe("aGVsbG8=");
  await expect(
    Effect.runPromise(
      Liquid.render(doc, { value: "hello" }).pipe(
        Effect.provide(Layer.merge(Render.layer({ maxOutputBytes: 4 }), Loader.memory({}))),
      ),
    ),
  ).rejects.toThrow("Output limit");
});

it("exposes string result types and preserves ordinary variable analysis", async () => {
  const doc = await Effect.runPromise(
    Liquid.parse("{{ input | base64_encode | base64_decode | upcase }}"),
  );
  expect(
    (await Effect.runPromise(Liquid.check(doc, Type.record({ input: Type.string })))).diagnostics,
  ).toEqual([]);
  expect((await Effect.runPromise(Liquid.analyze(doc))).externalRoots).toEqual(["input"]);
});

it("runs the same encoding filters in a browser bundle without Node globals", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { Effect } from "effect"; import { registry } from "./src/Builtins.js";
export const run = (name, value) => Effect.runPromise(registry.filters.get(name).run(value, [], {}));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "base64Test",
    write: false,
  });
  const context = { TextEncoder, TextDecoder, URL, setTimeout, clearTimeout };
  const api = runInNewContext(`${bundle.outputFiles[0]!.text}; base64Test`, context) as {
    run: (name: string, value: string) => Promise<string>;
  };
  expect(await api.run("base64_encode", "你好😀")).toBe("5L2g5aW98J+YgA==");
  expect(await api.run("base64_decode", "77u/YQ==")).toBe("\ufeffa");
  expect(await api.run("base64_decode", "_w")).toBe("�");
});
