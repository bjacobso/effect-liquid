import { describe, expect, it } from "vitest";
import { hash } from "../scripts/conformance/common.mjs";
import { extractTypeScript } from "../scripts/conformance/import-typescript.mjs";
import { baselineEntry, compare, expectation, regression } from "../scripts/conformance/runner.mjs";

const output = (text) => ({ kind: "output", sha256: hash(Buffer.from(text, "utf16le")) });
describe("conformance harness", () => {
  it("compares complete output including whitespace and unpaired surrogates", () => {
    expect(compare(output("a "), output("a"))).toBe("mismatch");
    expect(compare(output("\ud800"), output("\ufffd"))).toBe("mismatch");
    expect(expectation(output("ok"), { kind: "output", output: "ok" })).toBe("match");
  });
  it("gates golden failures even when engines agree", () => {
    const fixture = { id: "case", source: "x", expected: { kind: "output", output: "right" } };
    const wrong = output("wrong");
    expect(regression(fixture, wrong, wrong, {})).toBe("new-gap");
    const baseline = { case: baselineEntry(fixture, wrong, wrong) };
    expect(regression(fixture, wrong, wrong, baseline)).toBe("known-gap");
    expect(regression(fixture, output("different"), wrong, baseline)).toBe("changed-gap");
    expect(regression(fixture, output("right"), output("right"), baseline)).toBe("improved");
  });
  it("does not pin time-dependent oracle output for an unsupported configuration", () => {
    const fixture = { id: "unsupported", source: "{{ d | date: f }}", context: { d: "now" } };
    const unsupported = { kind: "unsupported-configuration", options: ["memoryLimit"] };
    const baseline = { unsupported: baselineEntry(fixture, output("yesterday"), unsupported) };
    expect(regression(fixture, output("today"), unsupported, baseline)).toBe("known-gap");
    expect(regression(fixture, { kind: "error", phase: "render" }, unsupported, baseline)).toBe(
      "changed-gap",
    );
    expect(regression(fixture, output("today"), output("today"), baseline)).toBe("improved");
  });
  it("does not equate error phases or infrastructure failures", () => {
    expect(
      compare(
        { kind: "error", phase: "parse", category: "syntax" },
        { kind: "error", phase: "render", category: "syntax" },
      ),
    ).toBe("mismatch");
    expect(compare({ kind: "timeout" }, { kind: "timeout" })).toBe("mismatch");
  });
  it("snapshots contexts at each call", () => {
    const { fixtures } = extractTypeScript(
      `import {test} from '../stub/render'; it('case',()=>{ const ctx={x:'first'}; test('{{x}}',ctx,'first'); ctx.x='second'; test('{{x}}',ctx,'second'); });`,
      "test/unit/example.ts",
    );
    expect(fixtures.map((f) => f.context.x)).toEqual(["first", "second"]);
  });
  it("excludes missing setup and unsupported control flow", () => {
    for (const setup of ["mock({file:'x'});", "if (true) ctx.x='changed';"]) {
      const { fixtures, inventory } = extractTypeScript(
        `import {test} from '../stub/render'; it('case',()=>{ const ctx={x:'first'}; ${setup} test('{{x}}',ctx,'first'); });`,
        "test/unit/example.ts",
      );
      expect(fixtures).toHaveLength(0);
      expect(inventory.some((x) => x.status === "excluded" && x.reason.includes("setup"))).toBe(
        true,
      );
    }
  });
});

it("restarts isolated workers after timeout and crash", async () => {
  const { EngineWorker } = await import("../scripts/conformance/runner.mjs");
  const worker = new EngineWorker("test", {
    timeoutMs: 100,
    workerPath: new URL("./fixtures-conformance-worker.mjs", import.meta.url),
  });
  try {
    expect((await worker.run({ source: "hang" })).kind).toBe("timeout");
    expect((await worker.run({ source: "ok" })).kind).toBe("parsed");
    expect((await worker.run({ source: "crash" })).kind).toBe("worker-crash");
    expect((await worker.run({ source: "ok" })).kind).toBe("parsed");
  } finally {
    worker.close();
  }
});
it("excludes suite-level host setup", () => {
  const { fixtures } = extractTypeScript(
    `import {test} from '../stub/render'; describe('case',()=>{ disableIntl(); it('nested',()=>test('hello','hello')); });`,
    "test/unit/example.ts",
  );
  expect(fixtures).toHaveLength(0);
});
