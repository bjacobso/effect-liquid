import { Effect, Layer } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";

const run = (source: string, context: object) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

describe("collection grouping", () => {
  it.each([
    "{{ items | group_by: 'kind' | json }}",
    "{{ items | group_by: '[\"kind\"]' | json }}",
    "{{ items | group_by: 'meta.kind' | json }}",
  ])("groups items in encounter order for %s", async (source) => {
    const context = {
      items: [
        { kind: "a", meta: { kind: "x" } },
        { kind: "b", meta: { kind: "y" } },
        { kind: "a", meta: { kind: "x" } },
        { meta: {} },
      ],
    };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  });
  it("distinguishes missing comparisons, empty values, and nil JSON", async () => {
    const context = { items: [{ kind: "a", tags: [] }, { kind: "b", tags: ["x"] }, {}] };
    for (const source of [
      "{{ items | where: 'kind', missing | json }}",
      "{{ items | where: 'tags', empty | json }}",
      "{{ items | find: 'kind', 'z' | json }}",
    ])
      expect(await run(source, context)).toBe(
        await new Reference().parseAndRender(source, context),
      );
  });
  it("supports Jekyll matching on missing fields and array members", async () => {
    const source =
      "{{ items | where: 'kind', missing | json }}|{{ items | where: 'tags', 'x' | json }}";
    const context = { items: [{ kind: "a", tags: [] }, { tags: ["x"] }] };
    const services = Layer.merge(Render.layer({ jekyllWhere: true }), Loader.memory({}));
    const actual = await Effect.runPromise(
      Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
        Effect.provide(services),
      ),
    );
    expect(actual).toBe(await new Reference({ jekyllWhere: true }).parseAndRender(source, context));
  });
  it("groups an object as key/value pairs", async () => {
    const source = "{{ items | group_by: 'kind' | json }}";
    const context = { items: { a: { kind: "x" }, b: { kind: "y" } } };
    expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
  });
});
