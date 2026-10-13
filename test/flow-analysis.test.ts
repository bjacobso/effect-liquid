import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Document, Node } from "../src/Ast.js";
import * as Builtins from "../src/Builtins.js";
import * as Filter from "../src/Filter.js";
import * as Liquid from "../src/Liquid.js";
import * as T from "../src/Type.js";

const analyze = (text: string) =>
  Effect.runPromise(Effect.flatMap(Liquid.parse({ id: "flow", text }), Liquid.analyze));
const check = (text: string, contract: T.Type) =>
  Effect.runPromise(Effect.flatMap(Liquid.parse(text), (doc) => Liquid.check(doc, contract)));
const context = T.record({
  left: T.record({ name: T.string }),
  right: T.record({ name: T.string }),
  items: T.array(T.number),
  flag: T.boolean,
  value: T.number,
});

describe("loop fixed points", () => {
  it("merges first-iteration and back-edge provenance into one occurrence with exact spans", async () => {
    const source =
      "{% assign x = left %}{% for item in items %}{{ x.name }}{% assign x = right %}{% endfor %}{{ x.name }}";
    const result = await analyze(source);
    expect(result.coverage).toBe("complete");
    expect(result.occurrences.map((o) => [o.path, o.span.start, o.span.end, o.external])).toEqual([
      ["left", 14, 18, true],
      ["items", 36, 41, true],
      ["x.name", 47, 53, false],
      ["right", 70, 75, true],
      ["x.name", 93, 99, false],
    ]);
    expect(
      result.occurrences.filter((o) => o.path === "x.name").map((o) => [...o.derivedPaths].sort()),
    ).toEqual([
      ["left.name", "right.name"],
      ["left.name", "right.name"],
    ]);
    expect(new Set(result.occurrences.map((o) => o.id)).size).toBe(result.occurrences.length);
    expect(result.bindings).toHaveLength(4);
    expect((await check(source, context)).passed).toBe(true);
  });
  it.each(["", "{% if flag %}{% continue %}{% endif %}", "{% if flag %}{% break %}{% endif %}"])(
    "preserves possible external reads after zero/conditional iterations: %s",
    async (control) => {
      const source = `{% for item in items %}${control}{% if flag %}{% assign x = value %}{% endif %}{% endfor %}{{ x }}`;
      const result = await analyze(source);
      const last = result.occurrences.at(-1)!;
      expect(last.path).toBe("x");
      expect(last.span).toEqual({
        sourceId: "flow",
        start: source.lastIndexOf("x"),
        end: source.lastIndexOf("x") + 1,
      });
      expect(last.external).toBe(true);
      expect(result.coverage).toBe("complete");
      const checked = await check(source, context);
      expect(checked.passed).toBe(false);
      expect(checked.coverage).toBe("complete");
      expect(checked.diagnostics.some((d) => d.code === "OptionalValue")).toBe(true);
    },
  );
  it("keeps reads before loop-carried writes external and ignores unreachable statements", async () => {
    const source =
      "{% for item in items %}{{ x }}{% assign x = value %}{% continue %}{{ unreachable }}{% endfor %}{{ x }}";
    const result = await analyze(source);
    expect(result.externalRoots).toEqual(["items", "x", "value"]);
    expect(result.occurrences.filter((o) => o.path === "x").every((o) => o.external)).toBe(true);
    expect(result.coverage).toBe("complete");
    const safe =
      "{% assign x = 0 %}{% for item in items %}{% assign x = x | plus: item %}{% if flag %}{% break %}{% endif %}{% endfor %}{{x}}";
    expect((await check(safe, context)).passed).toBe(true);
  });
  it("restores shadows, evaluates captures before binding, and scopes nested builtins", async () => {
    const source =
      "{{ forloop }}{% assign item = left %}{% for item in items %}{{item}}{{forloop.index}}{% assign item = right %}{% endfor %}{{item.name}}{% capture x %}{{x}}{% endcapture %}{{x}}";
    const result = await analyze(source);
    expect(result.externalRoots).toEqual(["forloop", "left", "items", "right", "x"]);
    expect(
      result.occurrences
        .find((o) => o.path === "item.name")
        ?.derivedPaths.slice()
        .sort(),
    ).toEqual(["left.name", "right.name"]);
    expect(result.occurrences.filter((o) => o.path === "x").map((o) => o.external)).toEqual([
      true,
      false,
    ]);
    const nested =
      "{% for i in items %}{% for j in items %}{{forloop.index}}{% endfor %}{{forloop.index}}{% endfor %}";
    expect((await check(nested, context)).passed).toBe(true);
  });
  it("bounds recursively growing provenance and makes widening visible", async () => {
    const result = await analyze(
      "{% assign x = root %}{% for item in items %}{{x}}{% assign x = x.child %}{% endfor %}",
    );
    expect(result.coverage).toBe("partial");
    expect(result.coverageReasons.some((r) => r.includes("widening"))).toBe(true);
    expect(result.occurrences).toHaveLength(4);
  });
});

it("uses declared caller values at conditional joins instead of replacing them with missing", async () => {
  const source = "{% if flag %}{% assign x = value %}{% endif %}{{x | plus: 1}}";
  expect(
    (await check(source, T.record({ flag: T.boolean, value: T.number, x: T.number }))).passed,
  ).toBe(true);
});
it.each(["user", "user != nil", "not user == nil", "user and flag"])(
  "narrows supported Liquid guards: %s",
  async (guard) => {
    expect(
      (
        await check(
          `{% if ${guard} %}{{user.name}}{% endif %}`,
          T.record({ user: T.optional(T.record({ name: T.string })), flag: T.boolean }),
        )
      ).passed,
    ).toBe(true);
  },
);
it("does not assume zero or empty strings are false", async () => {
  const contract = T.record({ value: T.union(T.literal(0), T.literal(""), T.nil) });
  const checked = await check("{% if value %}{{value}}{% endif %}", contract);
  expect(checked.passed).toBe(true);
  expect(Object.values(checked.expressionTypes)).toContainEqual(
    T.union(T.literal(0), T.literal("")),
  );
});
it("exposes opaque tags and unknown transformations without running handlers", async () => {
  let calls = 0;
  const registry = Filter.add(Builtins.registry, "opaque", {
    run: () => {
      calls++;
      return Effect.succeed(1);
    },
  });
  const doc = await Effect.runPromise(Liquid.parse("{% assign x = input | opaque %}{{x}}"));
  const analysis = await Effect.runPromise(Liquid.analyze(doc, registry));
  const checked = await Effect.runPromise(
    Liquid.check(doc, T.record({ input: T.number }), {}, registry),
  );
  expect(analysis.coverageReasons).toContain("Unknown transformation provenance: opaque at 14");
  expect(analysis.diagnostics[0]).toMatchObject({
    code: "UnknownTransformation",
    span: { start: 14 },
  });
  expect(checked.passed).toBe(false);
  expect(calls).toBe(0);
  const opaque = {
    ...doc,
    body: [
      { _tag: "Custom", span: { sourceId: doc.source.id, start: 0, end: 1 } } as unknown as Node,
    ],
  } satisfies Document;
  const opaqueAnalysis = await Effect.runPromise(Liquid.analyze(opaque));
  expect(opaqueAnalysis.coverage).toBe("partial");
  expect(opaqueAnalysis.diagnostics[0]).toMatchObject({
    code: "OpaqueExtension",
    span: { start: 0, end: 1 },
  });
  expect((await Effect.runPromise(Liquid.check(opaque, T.record({})))).passed).toBe(false);
});

it("analyzes known empty and single loops without fictitious back edges", async () => {
  const empty = await analyze(
    "{% for i in nil %}{{unreachable}}{% else %}{{fallback}}{% endfor %}",
  );
  expect(empty.externalRoots).toEqual(["fallback"]);
  const single = await analyze(
    "{% assign x = before %}{% for i in (1..1) %}{{x}}{% assign x = after %}{% else %}{{unreachable}}{% endfor %}{{x}}",
  );
  expect(single.occurrences.filter((o) => o.path === "x").map((o) => o.derivedPaths)).toEqual([
    ["before"],
    ["after"],
  ]);
  expect(
    (await check("{% for i in (1..1) %}{% assign x = 1 %}{% endfor %}{{x}}", T.record({}))).passed,
  ).toBe(true);
});

it.each(["for", "tablerow"])(
  "invalidates caller guards when %s shadows builtin metadata",
  async (tag) => {
    const builtin = tag === "for" ? "forloop" : "tablerowloop";
    const contract = T.record({
      items: T.array(T.number),
      [builtin]: T.record({ custom: T.string }),
    });
    const source = `{% if ${builtin} %}{% ${tag} item in items %}{{${builtin}.custom}}{% end${tag} %}{% endif %}`;
    const result = await check(source, contract);
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "UnknownProperty")).toBe(true);
    expect(
      (await check(`{% ${tag} item in items %}{{${builtin}.name}}{% end${tag} %}`, contract))
        .passed,
    ).toBe(true);
  },
);
