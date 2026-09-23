import { runInNewContext } from "node:vm";
import { Effect } from "effect";
import { build } from "esbuild";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

it("matches LiquidJS SHA-256 and HMAC coercion, including empty keys", async () => {
  const oracle = new Reference();
  for (const value of [null, "", "Polyjuice", 123, true, "你好😀", [1, 2], {}]) {
    const context = { value };
    const source = "{{ value | sha256 }}";
    expect(await run(source, context), JSON.stringify(context)).toBe(
      await oracle.parseAndRender(source, context),
    );
  }
  for (const [value, key] of [
    ["", ""],
    ["Polyjuice", "Polina"],
    ["hello", 42],
    [null, ""],
    ["你好😀", "🔑"],
  ] as const) {
    const context = { value, key };
    const source = "{{ value | hmac_sha256: key }}";
    expect(await run(source, context), JSON.stringify(context)).toBe(
      await oracle.parseAndRender(source, context),
    );
  }
});

it("exposes string results to the checker", async () => {
  const document = await Effect.runPromise(
    Liquid.parse("{{ value | sha256 | upcase }}{{ value | hmac_sha256: key | upcase }}"),
  );
  const result = await Effect.runPromise(
    Liquid.check(document, Type.record({ value: Type.string, key: Type.string })),
  );
  expect(result.diagnostics).toEqual([]);
});

it("runs in a browser bundle with Web Crypto and no Node globals", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { Effect } from "effect"; import { registry } from "./src/Builtins.js";
export const run = (name, value, key) => Effect.runPromise(registry.filters.get(name).run(value, [key], {}));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "cryptoTest",
    write: false,
  });
  const api = runInNewContext(`${bundle.outputFiles[0]!.text}; cryptoTest`, {
    crypto,
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
  }) as { run: (name: string, value: string, key: string) => Promise<string> };
  expect(await api.run("sha256", "", "")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(await api.run("hmac_sha256", "", "")).toBe(
    "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad",
  );
});
