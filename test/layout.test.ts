import { Effect, Layer } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

const templates = { base: "A{% block title %}Base{% endblock %}B{% block %}body{% endblock %}C" };
const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(), Loader.memory(templates))),
    ),
  );

describe("layout blocks", () => {
  it.each([
    '{% layout "base" %}{% block title %}Child{% endblock %}Hello',
    '{% layout "base" %}{% block title %}Child {{ block.super }}{% endblock %}Hello',
    "{% layout none %}{% block title %}Child{% endblock %}Hello",
    '{% layout "base" %}{% block title %}{{ name }}{% endblock %}Hello',
    "{% block title %}Standalone{% endblock %}",
  ])("matches pinned layout behavior for %s", async (source) => {
    const context = { name: "Ada" };
    expect(await run(source, context)).toBe(
      await new Reference({ templates }).parseAndRender(source, context),
    );
  });
  it("keeps child overrides through nested layouts", async () => {
    const nested = {
      outer: "O{% block title %}Outer{% endblock %}P",
      inner: '{% layout "outer" %}I{% block title %}Inner{% endblock %}J',
    };
    const source = '{% layout "inner" %}{% block title %}Child{% endblock %}Body';
    const actual = await Effect.runPromise(
      Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, {})).pipe(
        Effect.provide(Layer.merge(Render.layer(), Loader.memory(nested))),
      ),
    );
    expect(actual).toBe(await new Reference({ templates: nested }).parseAndRender(source));
  });
  it("reports layout analysis uncertainty and child variable reads", async () => {
    const document = await Effect.runPromise(
      Liquid.parse('{% layout "base" %}{% block title %}{{ name }}{% endblock %}'),
    );
    const analysis = await Effect.runPromise(Liquid.analyze(document));
    expect(analysis.externalRoots).toContain("name");
    expect(analysis.coverage).toBe("partial");
  });
});
