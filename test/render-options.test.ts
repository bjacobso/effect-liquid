import { Effect, Layer } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

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
