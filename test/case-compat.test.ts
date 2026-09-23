import { Effect } from "effect";
import { Liquid as Reference } from "liquidjs";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (document) => Liquid.render(document, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

it.each([
  '{% case "a" %}{% when "a" %}1{% when "a" %}2{% else %}E{% endcase %}',
  '{% case "a" %}{% when "a" %}{% assign next = "a" %}1{% when next %}2{% endcase %}',
  '{% case "b" %}{% when "a", "b" %}first{% when "b" %}second{% endcase %}',
  '{% case "a" %}{% when "b" %}1{% when "c" %}2{% else %}E{% endcase %}',
])("renders all matching when branches for %s", async (source) => {
  expect(await run(source)).toBe(await new Reference().parseAndRender(source));
});

it.each([
  '{% case blank %}{% when "" %}bar{% endcase %}',
  '{% case empty %}{% when "" %}bar{% endcase %}',
  "{% case nil %}{% when nil %}yes{% endcase %}",
  "{% case value %}{% when blank %}blank{% else %}other{% endcase %}",
  "{% if blank == blank %}yes{% else %}no{% endif %}",
  "{% if empty == empty %}yes{% else %}no{% endif %}",
])("matches special case and equality semantics for %s", async (source) => {
  const context = { value: "" };
  expect(await run(source, context)).toBe(await new Reference().parseAndRender(source, context));
});

it.each([
  "{% case true %}{% when false %}no{% else %}yes{% else %}no{% endcase %}",
  "{% case true %}{% when false %}no{% else %}yes{% else %}no{% when true %}no{% endcase %}",
  "{% case true %}{% when false %}no{% else %}yes{% when true %}also{% endcase %}",
])("uses only the first else branch for %s", async (source) => {
  expect(await run(source)).toBe(await new Reference().parseAndRender(source));
});
