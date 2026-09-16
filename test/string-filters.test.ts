import { Effect } from "effect";
import { Liquid as Reference } from "liquidjs";
import { describe, expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import * as Type from "../src/Type.js";

const run = (source: string, context: object = {}) =>
  Effect.runPromise(
    Effect.flatMap(Liquid.parse(source), (doc) => Liquid.render(doc, context)).pipe(
      Effect.provide(Liquid.layer),
    ),
  );

describe("string filter compatibility", () => {
  it("treats replacement text literally, including dollar substitution syntax", async () => {
    const source =
      '{{ text | replace_first: "a", replacement }}|{{ text | replace_last: "a", replacement }}';
    const context = { text: "aba", replacement: "$&$1" };
    expect(await run(source, context)).toBe("$&$1ba|ab$&$1");
  });
  it("supports absent and empty patterns in first/last replacement and removal", async () => {
    const source =
      '{{ "abc" | replace_first: "", "X" }}|{{ "abc" | replace_last: "", "X" }}|{{ "abc" | remove_first: "z" }}|{{ "abc" | remove_last: "" }}';
    expect(await run(source)).toBe("Xabc|abcX|abc|abc");
  });
  it("accepts custom strip character sets without treating them as regex syntax", async () => {
    expect(
      await run("{{ text | strip: chars }}|{{ text | lstrip: chars }}|{{ text | rstrip: chars }}", {
        text: "[--a--]",
        chars: "[]-",
      }),
    ).toBe("a|a--]|[--a");
    expect(await run('{{ "  a  " | strip: "" }}')).toBe("a");
  });
  it("preserves original types when truncate does not shorten its input", async () => {
    expect(
      await run(
        "{{ 123 | truncate: 10 | json }}|{{ true | truncate: 10 | json }}|{{ nil | truncate | json }}",
      ),
    ).toBe("123|true|null");
    expect(await run('{{ "abcdef" | truncate: 2 }}|{{ "abcdef" | truncate: 4, "!" }}')).toBe(
      "...|abc!",
    );
  });
  it.each([0, -2, 1, 2, 10, null, true, "bad"])(
    "matches pinned truncation coercion for %s",
    async (count) => {
      const source = "{{ text | truncate: count }}|{{ text | truncatewords: count }}";
      const context = { text: "one two", count };
      expect(await run(source, context)).toBe(
        await new Reference().parseAndRender(source, context),
      );
    },
  );
  it("preserves the pinned word-boundary suffix behavior", async () => {
    expect(await run('{{ "one two" | truncatewords: 2 }}|{{ "one two" | truncatewords: 3 }}')).toBe(
      "one two...|one two",
    );
  });
  it("distinguishes newline stripping, line breaks, and whitespace normalization", async () => {
    const source =
      "{{ text | strip_newlines }}|{{ text | newline_to_br }}|{{ text | normalize_whitespace }}|{{ text | squish }}";
    const context = { text: " a\r\nb\nc\r " };
    expect(await run(source, context)).toBe(" abc\r | a<br />\nb<br />\nc\r | a b c |a b c");
  });
  it("counts mixed CJK text consistently across repeated invocations", async () => {
    const source =
      '{{ text | number_of_words: "auto" }}|{{ text | number_of_words: "cjk" }}|{{ text | number_of_words }}';
    expect(await run(source, { text: "你好 world 日本語" })).toBe("6|6|3");
    expect(await run(source, { text: "你好 world 日本語" })).toBe("6|6|3");
  });
  it("escapes once using the pinned entity set", async () => {
    expect(await run("{{ text | escape_once }}", { text: "&amp; &lt; &quot; \" ' <" })).toBe(
      "&amp; &lt; &amp;quot; &#34; &#39; &lt;",
    );
    expect(await run("{{ text | xml_escape }}", { text: "<a>&" })).toBe("&lt;a&gt;&amp;");
  });
  it("removes HTML raw-text blocks and preserves unclosed trailing markup", async () => {
    const text =
      "A<script>ignored <b>x</b></script><style>css</style><!--comment--><b>B</b><unfinished";
    expect(await run("{{ text | strip_html }}", { text })).toBe("AB<unfinished");
    const malformed = "<!-->text-->tail";
    expect(await run("{{ text | strip_html }}", { text: malformed })).toBe(
      await new Reference().parseAndRender("{{ text | strip_html }}", { text: malformed }),
    );
    const unmatched = "<script".repeat(20000);
    expect(await run("{{ text | strip_html }}", { text: unmatched })).toBe(unmatched);
  });
  it("exposes argument and result types to checking while preserving input dependencies", async () => {
    const doc = await Effect.runPromise(
      Liquid.parse(
        "{{ title | replace_last: pattern, replacement | strip_newlines }} {{ title | number_of_words | plus: 1 }}",
      ),
    );
    const analysis = await Effect.runPromise(Liquid.analyze(doc));
    expect([...analysis.externalRoots].sort()).toEqual(["pattern", "replacement", "title"]);
    const result = await Effect.runPromise(
      Liquid.check(
        doc,
        Type.record({ title: Type.string, pattern: Type.string, replacement: Type.string }),
      ),
    );
    expect(result.diagnostics).toEqual([]);
  });
});
