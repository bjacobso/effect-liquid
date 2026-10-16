import { Effect } from "effect";
import type { Dialect } from "./Ast.js";
import { ParseError } from "./Diagnostic.js";
import { type Source, type Span, span } from "./Source.js";
export interface Token {
  readonly raw?: true;
  readonly kind: "text" | "output" | "tag";
  readonly text: string;
  readonly offset: number;
  readonly span: Span;
}
export interface WhitespaceOptions {
  readonly trimTagLeft?: boolean;
  readonly trimTagRight?: boolean;
  readonly trimOutputLeft?: boolean;
  readonly trimOutputRight?: boolean;
  readonly greedy?: boolean;
}
export const whitespaceKeys = [
  "trimTagLeft",
  "trimTagRight",
  "trimOutputLeft",
  "trimOutputRight",
  "greedy",
] as const;
export interface DelimiterOptions {
  readonly tagDelimiterLeft?: string;
  readonly tagDelimiterRight?: string;
  readonly outputDelimiterLeft?: string;
  readonly outputDelimiterRight?: string;
}
export const delimiterKeys = [
  "tagDelimiterLeft",
  "tagDelimiterRight",
  "outputDelimiterLeft",
  "outputDelimiterRight",
] as const;
export interface ParseOptions extends WhitespaceOptions, DelimiterOptions {
  readonly dialect?: Dialect;
  readonly errorMode?: "strict" | "strict2";
  readonly groupedExpressions?: boolean;
  readonly orderedFilterParameters?: boolean;
  readonly parseLimit?: number;
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
    const tagLeft = options.tagDelimiterLeft ?? "{%";
    const tagRight = options.tagDelimiterRight ?? "%}";
    const outputLeft = options.outputDelimiterLeft ?? "{{";
    const outputRight = options.outputDelimiterRight ?? "}}";
    if (
      [tagLeft, tagRight, outputLeft, outputRight].some((value) => !value || value.length > 32) ||
      tagLeft === outputLeft
    )
      return yield* Effect.fail(
        new ParseError({ message: "Invalid delimiters", span: span(source.id, 0, 0) }),
      );
    for (const [key, value] of Object.entries(options)) {
      if (key === "errorMode" && (value === "strict" || value === "strict2")) continue;
      if (key === "dialect" && (value === "ruby" || value === "liquidjs")) continue;
      if (key === "parseLimit" && typeof value === "number" && Number.isFinite(value) && value >= 0)
        continue;
      if (
        ["groupedExpressions", "orderedFilterParameters", ...whitespaceKeys].includes(key) &&
        typeof value === "boolean"
      )
        continue;
      if (
        delimiterKeys.includes(key as (typeof delimiterKeys)[number]) &&
        typeof value === "string"
      )
        continue;
      if (
        !["maxSourceLength", "maxTokens", "maxDepth"].includes(key) ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        return yield* Effect.fail(
          new ParseError({ message: `Invalid parse limit: ${key}`, span: span(source.id, 0, 0) }),
        );
    }
    if (
      text.length > Math.min(options.maxSourceLength ?? 1_000_000, options.parseLimit ?? 1_000_000)
    )
      return yield* Effect.fail(
        new ParseError({
          message: "Source length limit exceeded",
          span: span(source.id, 0, text.length),
        }),
      );
    const trimLeft = (value: string) =>
      options.greedy === false ? value.replace(/[ \t\r]+$/, "") : value.trimEnd();
    const trimRight = (value: string) =>
      options.greedy === false ? value.replace(/^[ \t\r]*\n?/, "") : value.trimStart();
    const tokens: Token[] = [];
    let i = 0;
    let trimNext = false;
    let trimBarrier = false;
    let work = 0;
    let commentStart: number | undefined;
    let commentName = "comment";
    let commentDepth = 0;
    const addText = (start: number, end: number, raw = false) => {
      let value = text.slice(start, end);
      if (trimNext) value = trimRight(value);
      trimNext = false;
      if (value && commentStart === undefined) {
        tokens.push({
          kind: "text",
          ...(raw ? { raw: true as const } : {}),
          text: value,
          offset: start,
          span: span(source.id, start, end),
        });
        trimBarrier = false;
      }
    };
    while (i < text.length) {
      if (++work % 128 === 0) yield* Effect.yieldNow();
      if (tokens.length >= (options.maxTokens ?? 100_000))
        return yield* Effect.fail(
          new ParseError({ message: "Token limit exceeded", span: span(source.id, i, i) }),
        );
      const start = i;
      while (i < text.length && !text.startsWith(tagLeft, i) && !text.startsWith(outputLeft, i)) {
        i++;
        if (i % 8192 === 0) yield* Effect.yieldNow();
      }
      addText(start, i);
      if (i === text.length) break;
      const open = i;
      const kind = text.startsWith(outputLeft, i) ? "output" : "tag";
      const close = kind === "output" ? outputRight : tagRight;
      i += kind === "output" ? outputLeft.length : tagLeft.length;
      const markedLeft = text[i] === "-";
      if (
        !trimBarrier &&
        (markedLeft || (kind === "tag" ? options.trimTagLeft : options.trimOutputLeft))
      ) {
        const last = tokens[tokens.length - 1];
        if (last?.kind === "text")
          tokens[tokens.length - 1] = { ...last, text: trimLeft(last.text) };
      }
      if (markedLeft) i++;
      const offset = i;
      const lineSyntax =
        kind === "tag" &&
        ((options.dialect === "ruby" && commentStart !== undefined) ||
          /^\s*(?:liquid\b|#)/.test(text.slice(offset)));
      let quote = "";
      while (i < text.length) {
        if (i % 8192 === 0) yield* Effect.yieldNow();
        if (lineSyntax && text.startsWith(close, i)) break;
        if (lineSyntax) {
          i++;
          continue;
        }
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
      i += close.length;
      trimNext = trim || !!(kind === "tag" ? options.trimTagRight : options.trimOutputRight);
      const tag = content.trim();
      if (kind === "tag" && options.dialect === "ruby" && tag === "doc") {
        const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
          `${escape(tagLeft)}-?\\s*(doc|enddoc)\\b[\\s\\S]*?(-)?${escape(tagRight)}`,
          "g",
        );
        pattern.lastIndex = i;
        const end = pattern.exec(text);
        if (!end || end[1] !== "enddoc")
          return yield* Effect.fail(
            new ParseError({ message: "Unclosed or nested doc", span: span(source.id, open, i) }),
          );
        i = end.index + end[0].length;
        trimNext = !!end[2] || !!options.trimTagRight;
        trimBarrier = true;
        continue;
      }
      if (kind === "tag" && commentStart !== undefined) {
        if (options.dialect !== "ruby" && !/^\s*[A-Za-z_#][\w-]*/.test(content))
          return yield* Effect.fail(
            new ParseError({ message: "Invalid comment-body tag", span: span(source.id, open, i) }),
          );
        if (options.dialect === "ruby" && new RegExp(`^${commentName}\\b`).test(tag)) {
          commentDepth++;
          continue;
        }
        if (new RegExp(`^end${commentName}\\b`).test(tag)) {
          if (commentDepth > 0) {
            commentDepth--;
            continue;
          }
          commentStart = undefined;
          trimBarrier = true;
          continue;
        }
      }
      if (
        kind === "tag" &&
        (tag === "comment" ||
          tag.startsWith("comment}") ||
          (options.dialect === "ruby" && tag === "doc")) &&
        commentStart === undefined
      ) {
        commentStart = open;
        commentName = tag === "doc" ? "doc" : "comment";
        trimBarrier = true;
      } else if (kind === "tag" && tag === "raw") {
        const bodyStart = i;
        const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const endPattern = new RegExp(
          options.dialect === "ruby"
            ? `${escapeRegex(tagLeft)}(-)?\\s*endraw\\s*(-)?${escapeRegex(tagRight)}`
            : `${escapeRegex(tagLeft)}()\\s*endraw\\b[\\s\\S]*?(-)?${escapeRegex(tagRight)}`,
          "g",
        );
        endPattern.lastIndex = i;
        const match = endPattern.exec(text);
        if (!match)
          return yield* Effect.fail(
            new ParseError({ message: "Unclosed raw", span: span(source.id, open, i) }),
          );
        // Ruby accepts marked endraw delimiters. Both engines preserve literal body whitespace.
        trimNext = false;
        addText(bodyStart, match.index, true);
        trimNext = !!match[2] || !!options.trimTagRight;
        i = match.index + match[0].length;
        trimBarrier = true;
      } else if (commentStart === undefined)
        tokens.push({ kind, text: content, offset, span: span(source.id, open, i) });
    }
    if (commentStart !== undefined)
      return yield* Effect.fail(
        new ParseError({ message: "Unclosed comment", span: span(source.id, commentStart, i) }),
      );
    return tokens;
  });
