import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

const fixtures = JSON.parse(readFileSync("conformance/fixtures/local.json", "utf8")) as Array<{
  id: string;
  source: string;
  context?: Record<string, unknown>;
  templates?: Record<string, string>;
}>;

const reference = JSON.parse(
  execFileSync(process.execPath, ["scripts/oracle.mjs"], {
    input: JSON.stringify(fixtures),
    encoding: "utf8",
    timeout: 10_000,
  }),
) as { output?: string; error?: string }[];
describe("LiquidJS 10.29.0 original conformance fixtures", () => {
  fixtures.forEach((fixture, index) => {
    it(`${index}: ${fixture.source}`, async () => {
      const context = "context" in fixture ? fixture.context : {};
      const templates = fixture.templates ?? {};
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* Liquid.render(yield* Liquid.parse(fixture.source), context);
        }).pipe(Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates)))),
      );
      if (fixture.id === "local:raw-trim") {
        expect(reference[index]?.error).toContain("not closed");
        expect(output).toBe("x {{y}} z");
      } else {
        expect(reference[index]?.error).toBeUndefined();
        expect(output).toEqual(reference[index]?.output);
      }
    });
  });
});
