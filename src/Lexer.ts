import { Effect } from "effect";
import { ParseError } from "./Diagnostic.js";
import { type Source, type Span, span } from "./Source.js";
export interface Token {
  readonly kind: "text" | "output" | "tag";
  readonly text: string;
  readonly offset: number;
  readonly span: Span;
}
export interface ParseOptions {
  readonly maxSourceLength?: number;
  readonly maxTokens?: number;
  readonly maxDepth?: number;
}
export const lex = (
  source: Source,
  options: ParseOptions = {},
): Effect.Effect<readonly Token[], ParseError> =>
  Effect.gen(function* () {
    const text = source.text;
    for (const [key, value] of Object.entries(options)) {
      if (
        !["maxSourceLength", "maxTokens", "maxDepth"].includes(key) ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        return yield* Effect.fail(
          new ParseError({ message: `Invalid parse limit: ${key}`, span: span(source.id, 0, 0) }),
        );
    }
    if (text.length > (options.maxSourceLength ?? 1_000_000))
      return yield* Effect.fail(
        new ParseError({
          message: "Source length limit exceeded",
          span: span(source.id, 0, text.length),
        }),
      );
    const tokens: Token[] = [];
    let i = 0;
    let trimNext = false;
    let work = 0;
    const addText = (start: number, end: number) => {
      let value = text.slice(start, end);
      if (trimNext) value = value.trimStart();
      trimNext = false;
      if (value)
        tokens.push({
          kind: "text",
          text: value,
          offset: start,
          span: span(source.id, start, end),
        });
    };
    while (i < text.length) {
      if (++work % 128 === 0) yield* Effect.yieldNow();
      if (tokens.length >= (options.maxTokens ?? 100_000))
        return yield* Effect.fail(
          new ParseError({ message: "Token limit exceeded", span: span(source.id, i, i) }),
        );
      const start = i;
      while (
        i < text.length &&
        !(text[i] === "{" && (text[i + 1] === "{" || text[i + 1] === "%"))
      ) {
        i++;
        if (i % 8192 === 0) yield* Effect.yieldNow();
      }
      addText(start, i);
      if (i === text.length) break;
      const open = i;
      const kind = text[i + 1] === "{" ? "output" : "tag";
      const close = kind === "output" ? "}}" : "%}";
      i += 2;
      if (text[i] === "-") {
        const last = tokens[tokens.length - 1];
        if (last?.kind === "text")
          tokens[tokens.length - 1] = { ...last, text: last.text.trimEnd() };
        i++;
      }
      const offset = i;
      let quote = "";
      while (i < text.length) {
        if (i % 8192 === 0) yield* Effect.yieldNow();
        if (quote) {
          if (text[i] === "\\") i++;
          else if (text[i] === quote) quote = "";
        } else if (text[i] === '"' || text[i] === "'") quote = text[i]!;
        else if (text.startsWith(close, i)) break;
        i++;
      }
      if (i >= text.length)
        return yield* Effect.fail(
          new ParseError({ message: `Unclosed ${kind}`, span: span(source.id, open, text.length) }),
        );
      const trim = text[i - 1] === "-";
      const content = text.slice(offset, trim ? i - 1 : i);
      i += 2;
      trimNext = trim;
      const tag = content.trim();
      if (kind === "tag" && (tag === "raw" || tag === "comment")) {
        const bodyStart = i;
        const endPattern = new RegExp(`{%(-)?\\s*end${tag}\\s*(-)?%}`, "g");
        endPattern.lastIndex = i;
        const match = endPattern.exec(text);
        if (!match)
          return yield* Effect.fail(
            new ParseError({ message: `Unclosed ${tag}`, span: span(source.id, open, i) }),
          );
        if (tag === "raw") {
          addText(bodyStart, match.index);
          if (match[1]) {
            const last = tokens[tokens.length - 1];
            if (last?.kind === "text")
              tokens[tokens.length - 1] = { ...last, text: last.text.trimEnd() };
          }
        }
        trimNext = !!match[2];
        i = match.index + match[0].length;
      } else tokens.push({ kind, text: content, offset, span: span(source.id, open, i) });
    }
    return tokens;
  });
