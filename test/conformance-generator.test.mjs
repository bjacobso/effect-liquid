import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { generate } from "../scripts/conformance/generate.mjs";
import { EngineWorker } from "../scripts/conformance/runner.mjs";
it("generates bounded reproducible templates with seed-dependent choices", () => {
  const first = generate(42, 100, "ruby");
  expect(first).toEqual(generate(42, 100, "ruby"));
  expect(first).not.toEqual(generate(43, 100, "ruby"));
  expect(first.every((f) => f.source.length < 1000 && f.context.xs.length < 5)).toBe(true);
});
it.skipIf(!existsSync(".cache/ruby-gems/oracle-pin.json"))(
  "runs the pinned Ruby value/filesystem/clock adapters in isolation",
  async () => {
    const worker = new EngineWorker("ruby");
    try {
      const result = await worker.run({
        source: "{{x}}/{% render 'p' %}/{{'today'|date:'%Y'}}",
        context: { x: { $liquid: { type: "float", value: "0.0" } } },
        globals: { shop: "Ada" },
        templates: { p: "{{shop}}" },
        clock: "2024-01-01T00:00:00Z",
      });
      expect(result.kind).toBe("output");
      expect(result.output).toBe("0.0/Ada/2024");
    } finally {
      worker.close();
    }
  },
);
