import { Effect, Layer, Stream } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Render from "../src/Render.js";
import * as Loader from "../src/TemplateLoader.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: unknown = {}, config: Partial<Render.Config> = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Layer.merge(Render.layer(config), Loader.memory({}))),
    ),
  );

describe("liquid blocks", () => {
  it("supports nested control flow, filters, blank lines, CRLF, and whitespace control", async () => {
    const source = [
      " before ",
      "{%- liquid",
      " assign total = 0",
      " for item in items",
      "   assign total = total | plus: item",
      "   if item > 1",
      "     echo item | times: 2",
      "   endif",
      "",
      " endfor",
      " echo total",
      "-%}",
      " after ",
    ].join("\r\n");
    expect(await run(source, { items: [1, 2, 3] })).toBe(" before466after ");
    expect(await run("{% liquid %}")).toBe("");
  });
  it("ignores comments without interpreting quotes or expressions", async () => {
    const source = `{% liquid
# don't evaluate {{ missing }} or "quotes
comment
bad ' syntax
endcomment
echo 'ok'
%}{% # another ' comment %}`;
    expect(await run(source)).toBe("ok");
  });
  it("preserves exact source locations for reads and parse errors", async () => {
    const source = "😀\r\n{% liquid\r\n  echo user.name\r\n%}";
    const doc = await Effect.runPromise(Liquid.parse(source));
    const result = await Effect.runPromise(Liquid.analyze(doc));
    expect(result.externalPaths).toContain("user.name");
    const read = result.occurrences[0]!;
    expect(source.slice(read.span.start, read.span.end)).toBe("user.name");
    const invalid = "{% liquid\n echo value |\n%}";
    const failure = await Effect.runPromise(Effect.flip(Liquid.parse(invalid)));
    expect(failure.span.start).toBe(invalid.indexOf("|") + 1);
  });
  it.each([
    "{% liquid\n if true\n%}{% endif %}",
    "{% liquid\n comment\n%}",
    '{% liquid\n echo "unfinished\n%}',
    "{% # first\n second %}",
  ])("rejects malformed block %s", async (source) => {
    expect(await Effect.runPromise(Effect.isFailure(Liquid.parse(source)))).toBe(true);
  });
  it("enforces expansion token and nesting limits", async () => {
    const source = "{% liquid\necho 1\necho 2\necho 3\n%}";
    expect(
      (await Effect.runPromise(Effect.flip(Liquid.parse(source, { maxTokens: 3 })))).message,
    ).toContain("Token limit");
    expect(
      (
        await Effect.runPromise(
          Effect.flip(Liquid.parse("{% liquid liquid liquid echo 1 %}", { maxDepth: 1 })),
        )
      ).message,
    ).toContain("nesting limit");
  });
});

describe("table rows", () => {
  it("renders exact row/cell markup and column metadata after offset and limit", async () => {
    const source =
      "{% tablerow x in (1..6) cols:2 offset:1 limit:3 %}{{x}}:{{tablerowloop.index}}/{{tablerowloop.row}}/{{tablerowloop.col}}/{{tablerowloop.col_first}}/{{tablerowloop.col_last}}{% endtablerow %}";
    const expected =
      '<tr class="row1"><td class="col1">2:1/1/1/true/false</td><td class="col2">3:2/1/2/false/true</td></tr><tr class="row2"><td class="col1">4:3/2/1/true/false</td></tr>';
    expect(await run(source)).toBe(expected);
    expect(await new Reference().parseAndRender(source)).toBe(expected);
  });
  it("handles empty input, strings, and default columns", async () => {
    expect(
      await run("{% tablerow x in empty_list %}{{x}}{% endtablerow %}", { empty_list: [] }),
    ).toBe("");
    expect(await run('{% tablerow x in "hi" cols:0 %}{{x}}{% endtablerow %}')).toBe(
      '<tr class="row1"><td class="col1">hi</td></tr>',
    );
  });
  it("restores outer bindings after nested tables", async () => {
    const source =
      "{% tablerow x in (1..2) cols:1 %}{{x}}{% tablerow x in (3..4) %}{{x}}{% endtablerow %}{{x}}/{{tablerowloop.index}}{% endtablerow %}{{x}}/{{tablerowloop}}";
    const context = { x: "outer", tablerowloop: "outer-loop" };
    expect(await run(source, context)).toBe(
      await new Reference().parseAndRender(source, structuredClone(context)),
    );
    expect(context.x).toBe("outer");
  });
  it("includes generated markup in output limits and bounds iterations", async () => {
    const source = "{% tablerow x in (1..3) %}{% endtablerow %}";
    await expect(run(source, {}, { maxOutputBytes: 10 })).rejects.toThrow("Output limit");
    await expect(
      run(source.replace("(1..3)", "items"), { items: [1, 2, 3] }, { maxIterations: 1 }),
    ).rejects.toThrow("Iteration limit");
  });
  it("streams the same output and can replay after early termination", async () => {
    const doc = await Effect.runPromise(
      Liquid.parse("{% liquid\ntablerow x in (1..3) cols:2\necho x\nendtablerow\n%}"),
    );
    const stream = Liquid.renderStream(doc).pipe(
      Stream.provideLayer(Layer.merge(Render.layer(), Loader.memory({}))),
    );
    await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1)));
    const result = await Effect.runPromise(Stream.runFold(stream, "", (a, b) => a + b));
    expect(result).toBe(await run(doc.source.text));
  });
  it("analyzes collections and column inputs while checking local metadata", async () => {
    const doc = await Effect.runPromise(
      Liquid.parse(
        "{% tablerow item in items cols:columns %}{{ item.name }}{{ tablerowloop.col | plus: 1 }}{% endtablerow %}",
      ),
    );
    const analysis = await Effect.runPromise(Liquid.analyze(doc));
    expect([...analysis.externalRoots].sort()).toEqual(["columns", "items"]);
    expect(analysis.derivedInputPaths).toContain("items[*].name");
    const checked = await Effect.runPromise(
      Liquid.check(
        doc,
        Type.record({
          items: Type.array(Type.record({ name: Type.string })),
          columns: Type.number,
        }),
      ),
    );
    expect(checked.diagnostics).toEqual([]);
  });
});
