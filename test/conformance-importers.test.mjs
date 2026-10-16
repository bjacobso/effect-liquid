import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { yamlCases } from "../scripts/conformance/import-yaml.mjs";
import { jsonProjection } from "../scripts/conformance/encoding.mjs";
import { regression } from "../scripts/conformance/runner.mjs";

it("preserves static environments and YAML numeric kinds", () => {
  const [f] = yamlCases(
    'specs:\n- template: "{{ x }}"\n  environment: { x: 0.0, y: 2 }\n  filesystem: { item: "{{ x }}" }\n  expected: "0.0"\n',
    "specs/test.yml",
    ".context",
  );
  expect(f.context).toEqual({});
  expect(f.globals).toEqual({
    x: { $liquid: { type: "float", value: "0.0" } },
    y: { $liquid: { type: "integer", value: "2" } },
  });
  expect(f.templates).toEqual({ item: "{{ x }}" });
  expect(f.authority).toBe("ruby");
  expect(jsonProjection(f.globals)).toEqual({ x: 0, y: 2 });
});

// CI executes checked-in fixtures without Ruby; extraction is tested when Ruby is installed.
const ruby = (() => {
  try {
    execFileSync("ruby", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
it.skipIf(!ruby)(
  "extracts Ruby keyword partials and lossless host values without running test code",
  () => {
    const root = mkdtempSync(join(tmpdir(), "liquid-import-"));
    try {
      const file = join(root, "test.rb");
      writeFileSync(
        file,
        `def test_static\n assert_template_result('ok', "{% render 'item' %}", partials: {'item' => 'ok'})\n assert_template_result('x', '{{ x }}', {'x' => [0.0, 1, :foo, (2..4), BigDecimal('0.1')], 'h' => {foo: 'bar'}})\nend\n`,
      );
      const [{ result }] = JSON.parse(
        execFileSync("ruby", ["scripts/conformance/import-ruby.rb"], {
          input: JSON.stringify([
            { absolute: file, path: "test.rb", repository: "shopify-liquid" },
          ]),
          encoding: "utf8",
        }),
      );
      expect(result.fixtures).toHaveLength(2);
      expect(result.fixtures[0].templates).toEqual({ item: "ok" });
      expect(result.fixtures[0].context).toEqual({});
      const values = result.fixtures[1].globals.x;
      expect(values.map((v) => v.$liquid.type)).toEqual([
        "float",
        "integer",
        "symbol",
        "range",
        "decimal",
      ]);
      expect(result.fixtures[1].globals.h.$liquid.entries[0][0].$liquid.type).toBe("symbol");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("scores LiquidJS authority independently of a contradictory upstream expectation", () => {
  const f = { id: "dialect", authority: "liquidjs", expected: { kind: "error", phase: "parse" } };
  expect(regression(f, { kind: "parsed" }, { kind: "parsed" }, {})).toBe("pass");
});
