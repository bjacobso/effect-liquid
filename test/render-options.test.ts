import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, parseOptions = {}, renderOptions = {}, context = {}, templates = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, parseOptions), (document) =>
      Liquid.render(document, context),
    ).pipe(Effect.provide(Layer.merge(Render.layer(renderOptions), Loader.memory(templates)))),
  );

describe("render and delimiter options", () => {
  it("keeps missing conditions lenient in strict mode", async () => {
    const source = "{% if missing != 'x' %}yes{% endif %}|{{ missing | default: 'fallback' }}";
    const options = { strictVariables: true, lenientIf: true };
    expect(await run(source, {}, options)).toBe(
      await new Reference(options).parseAndRender(source),
    );
  });
  it.each(["escape", "json"] as const)(
    "applies %s output escaping, with raw opt out",
    async (outputEscape) => {
      const source = '{{ "<" }}|{{ "<" | raw }}';
      expect(await run(source, {}, { outputEscape })).toBe(
        await new Reference({ outputEscape }).parseAndRender(source),
      );
    },
  );
  it("parses custom tag and output delimiters through partials and raw blocks", async () => {
    const options = {
      tagDelimiterLeft: "<%=",
      tagDelimiterRight: "%>",
      outputDelimiterLeft: "<<",
      outputDelimiterRight: ">>",
    };
    const source = '<%= render "child" %>|<%= raw %><%= if false %>raw<%= endraw %>';
    const templates = { child: "<< name | upcase >>" };
    const context = { name: "ada" };
    expect(await run(source, options, {}, context, templates)).toBe(
      await new Reference({ ...options, templates }).parseAndRender(source, context),
    );
  });
});

it.each([
  "offset:2 reversed limit:3",
  "limit:3 offset:2 reversed",
  "reversed offset:2 limit:3",
  "limit:3 reversed offset:2",
  "limit:5 offset:1 limit:2",
  "offset:2 limit:2 reversed",
])("applies ordered loop modifiers: %s", async (modifiers) => {
  const source = `{% for i in (1..8) ${modifiers} %}{{ i }}{% endfor %}`;
  for (const orderedFilterParameters of [false, true]) {
    const options = { orderedFilterParameters };
    expect(await run(source, options)).toBe(await new Reference(options).parseAndRender(source));
  }
});

it("carries ordered loop semantics into partial rendering, analysis, and checking", async () => {
  const source = '{% render "child" %}';
  const templates = {
    child: "{% for i in (1..8) limit:1 offset:1 %}{{ missing }}{% endfor %}",
  };
  const options = { orderedFilterParameters: true };
  expect(await run(source, options, {}, {}, templates)).toBe(
    await new Reference({ ...options, templates }).parseAndRender(source),
  );
  const doc = await Effect.runPromise(Liquid.parse(source, options));
  const analysis = await Effect.runPromise(
    Liquid.analyzeProject(doc).pipe(Effect.provide(Loader.memory(templates))),
  );
  expect(analysis.externalPaths).toEqual([]);
  const checked = await Effect.runPromise(
    Liquid.checkProject(doc, Type.record({})).pipe(Effect.provide(Loader.memory(templates))),
  );
  expect(checked.passed).toBe(true);
});

it("snapshots ordered modifiers in liquid blocks and shares continuation cursors", async () => {
  const source = `{% liquid
for i in (1..8) limit:4 offset:2 reversed
  echo i
endfor
for i in (1..8) limit:6 offset:continue
  echo i
endfor
%}`;
  const options = { orderedFilterParameters: true };
  const expected = await new Reference(options).parseAndRender(source);
  expect(await run(source, options)).toBe(expected);
  const chunks = await Effect.runPromise(
    Effect.flatMap(Liquid.parse(source, options), (doc) =>
      Stream.runCollect(Liquid.renderStream(doc)),
    ).pipe(Effect.provide(Liquid.layer)),
  );
  expect(Array.from(chunks).join("")).toBe(expected);
});
