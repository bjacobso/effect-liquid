import { Effect, Layer } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

it("renders an interpolated include filename in caller scope", async () => {
  const source = '{% include "cards/{{ name | downcase }}" %}';
  const context = { name: "ADA" };
  const templates = { "cards/ada": "Hello {{ name }}" };
  const actual = await Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );
  expect(actual).toBe(await new Reference({ templates }).parseAndRender(source, context));
});
