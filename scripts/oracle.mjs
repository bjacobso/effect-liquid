import { readFileSync } from "node:fs";
import { Liquid } from "liquidjs";

const fixtures = JSON.parse(readFileSync(0, "utf8"));
const output = [];
for (const fixture of fixtures) {
  const engine = new Liquid({
    strictFilters: true,
    ...fixture.options,
    templates: fixture.templates ?? {},
  });
  try {
    output.push({ output: await engine.parseAndRender(fixture.source, fixture.context ?? {}) });
  } catch (error) {
    output.push({ error: error.message });
  }
}
process.stdout.write(JSON.stringify(output));
