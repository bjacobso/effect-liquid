import { readFileSync } from "node:fs";
import { Liquid } from "liquidjs";
import { expect, it } from "vitest";
import { registry } from "../src/Builtins.js";

it("inventories every pinned reference tag, filter, and normalized option", () => {
  const manifest = JSON.parse(readFileSync("CONFORMANCE.json", "utf8"));
  const engine = new Liquid();
  expect(Object.keys(manifest.tags).sort()).toEqual(Object.keys(engine.tags).sort());
  expect(Object.keys(manifest.filters).sort()).toEqual(Object.keys(engine.filters).sort());
  expect(Object.keys(manifest.options).sort()).toEqual(Object.keys(engine.options).sort());
  for (const name of registry.filters.keys())
    expect(manifest.filters[name]?.status).toBe("partial");
});
