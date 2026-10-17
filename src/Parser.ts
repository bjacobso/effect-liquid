import { Effect } from "effect";
import type { Dialect, Document, Expression, Node, PartialBinding } from "./Ast.js";
import { ParseError } from "./Diagnostic.js";
import { Expressions } from "./ExpressionParser.js";
import { delimiterKeys, lex, type ParseOptions, type Token, whitespaceKeys } from "./Lexer.js";
import { make, type Source, span } from "./Source.js";

class Templates {
  pos = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly maxDepth: number,
    readonly budget: { remaining: number },
    readonly groupedExpressions = false,
    readonly orderedFilterParameters = false,
    readonly dialect: Dialect = "liquidjs",
    readonly errorMode: "strict" | "strict2" = "strict",
    readonly recover = false,
  ) {}
  tag() {
    const t = this.tokens[this.pos];
    return t?.kind === "tag" ? t.text.trim().split(/\s/)[0] : undefined;
  }
  *body(stops: readonly string[] = [], depth = 0, loop = false): Generator<void, Node[]> {
    const nodes: Node[] = [];
    while (this.pos < this.tokens.length && !stops.includes(this.tag() ?? "")) {
      yield;
      const t = this.tokens[this.pos++]!;
      if (t.kind === "text") {
        nodes.push({
          _tag: "Text",
          ...(t.raw ? { raw: true as const } : {}),
          value: t.text,
          span: t.span,
        });
        continue;
      }
      if (depth > this.maxDepth)
        throw new ParseError({ message: "Template nesting limit exceeded", span: t.span });
      const liquid = t.kind === "tag" ? /^\s*liquid(?=\s|$)/.exec(t.text) : null;
      if (liquid) {
        const lines: Token[] = [];
        let start = liquid[0].length;
        while (start < t.text.length) {
          yield;
          const newline = t.text.indexOf("\n", start);
          const end = newline < 0 ? t.text.length : newline;
          const text = t.text.slice(start, end);
          const at = span(t.span.sourceId, t.offset + start, t.offset + end);
          if (text.trim()) {
            if (--this.budget.remaining < 0)
              throw new ParseError({ message: "Token limit exceeded", span: at });
            lines.push({ kind: "tag", text, offset: t.offset + start, span: at });
          }
          start = end + 1;
        }
        const nested = yield* new Templates(
          lines,
          this.maxDepth,
          this.budget,
          this.groupedExpressions,
          this.orderedFilterParameters,
          this.dialect,
          this.errorMode,
          this.recover,
        ).body([], depth + 1, loop);
        for (const node of nested) nodes.push(node);
        continue;
      }
      if (t.kind === "tag" && t.text.trimStart().startsWith("#")) {
        if (/\n\s*[^#\s]/.test(t.text.trimStart().slice(1).trim()))
          throw new ParseError({
            message: "Every inline comment line must start with #",
            span: t.span,
          });
        continue;
      }
      if (t.kind === "tag" && t.text.trim() === "comment") {
        let nesting = 1;
        while (this.pos < this.tokens.length && nesting) {
          const name = this.tag();
          this.pos++;
          yield;
          if (name === "comment" && this.dialect === "ruby") nesting++;
          else if (name === "endcomment") nesting--;
        }
        if (nesting) throw new ParseError({ message: "Unclosed comment", span: t.span });
        continue;
      }
      const e = new Expressions(
        t,
        this.maxDepth,
        this.groupedExpressions,
        this.dialect,
        this.errorMode === "strict2",
        this.recover,
      );
      if (depth > this.maxDepth) e.fail("Template nesting limit exceeded");
      if (t.kind === "output") {
        const expression: Expression =
          this.dialect === "ruby" && !e.words.length
            ? { _tag: "Literal", value: null, span: t.span }
            : e.pipeline(this.recover);
        e.done();
        nodes.push({ _tag: "Output", expression, span: t.span });
        continue;
      }
      const tag = e.name();
      const end = (name: string) => {
        const close = this.tokens[this.pos++];
        if (
          !close ||
          (this.recover && ["endcapture", "endcase"].includes(name)
            ? close.text.trim().split(/\s/)[0] !== name
            : close.text.trim() !== name)
        )
          e.fail(`Expected ${name}`);
        return { ...t.span, end: close!.span.end };
      };
      if (tag === "increment" || tag === "decrement") {
        const start = e.words[e.pos]?.start ?? t.text.length;
        const name =
          this.recover &&
          (!e.words[e.pos] ||
            e.words[e.pos]!.quoted ||
            !/^[\p{L}\p{M}\p{N}_?-]+$/u.test(e.words[e.pos]!.text))
            ? ""
            : e.name();
        e.done();
        nodes.push({
          _tag: "Counter",
          name,
          direction: tag === "increment" ? 1 : -1,
          nameSpan: e.position(start),
          span: t.span,
        });
      } else if (tag === "cycle") {
        if (this.recover) {
          let group: Expression | undefined;
          const values: Expression[] = [];
          const can = () => {
            const w = e.words[e.pos];
            return (
              !!w &&
              (w.quoted || /^[\p{L}\p{M}\p{N}_?-]+$/u.test(w.text) || ["(", "["].includes(w.text))
            );
          };
          if (can()) {
            const first = e.atom();
            if (e.take(":")) group = first;
            else values.push(first);
          }
          while (e.pos < e.words.length) {
            if (can()) values.push(e.atom());
            while (e.pos < e.words.length && !e.peek(",")) e.pos++;
            e.take(",");
          }
          if (!values.length) e.fail("Empty cycle candidates");
          const key = values
            .map((value) => t.text.slice(value.span.start - t.offset, value.span.end - t.offset))
            .join(",");
          nodes.push({ _tag: "Cycle", ...(group ? { group } : {}), values, key, span: t.span });
          continue;
        }

        const first = e.atom();
        const group = e.take(":") ? first : undefined;
        const values = group ? [e.atom()] : [first];
        while (e.take(",") && e.pos < e.words.length) values.push(e.atom());
        e.done();
        const key = values
          .map((value) => t.text.slice(value.span.start - t.offset, value.span.end - t.offset))
          .join(",");
        nodes.push({ _tag: "Cycle", ...(group ? { group } : {}), values, key, span: t.span });
      } else if (tag === "assign") {
        const name = e.bindingName();
        e.need("=");
        const expression = e.pipeline(this.recover);
        e.done();
        nodes.push({ _tag: "Assign", name, expression, span: t.span });
      } else if (tag === "echo") {
        if (e.pos < e.words.length) {
          const expression = e.pipeline(this.recover);
          e.done();
          nodes.push({ _tag: "Output", expression, span: t.span });
        }
      } else if (tag === "capture") {
        const name = e.words[e.pos]?.quoted ? e.words[e.pos++]!.text : e.name();
        e.done();
        const body = yield* this.body(["endcapture"], depth + 1, loop);
        nodes.push({ _tag: "Capture", name, body, span: end("endcapture") });
      } else if (tag === "if" || tag === "unless") {
        let condition = this.recover ? e.pipeline(true) : e.condition();
        e.done();
        if (tag === "unless") condition = { _tag: "Not", value: condition, span: condition.span };
        const branches = [
          { condition, body: yield* this.body(["elsif", "else", `end${tag}`], depth + 1, loop) },
        ];
        while (this.tag() === "elsif") {
          const b = new Expressions(
            this.tokens[this.pos++]!,
            this.maxDepth,
            this.groupedExpressions,
            this.dialect,
            this.errorMode === "strict2",
            this.recover,
          );
          b.need("elsif");
          const condition = this.recover ? b.pipeline(true) : b.condition();
          b.done();
          branches.push({
            condition,
            body: yield* this.body(["elsif", "else", `end${tag}`], depth + 1, loop),
          });
        }
        let otherwise: Node[] = [];
        if (this.tag() === "else") {
          const b = new Expressions(
            this.tokens[this.pos++]!,
            this.maxDepth,
            this.groupedExpressions,
            this.dialect,
            this.errorMode === "strict2",
            this.recover,
          );
          b.need("else");
          b.done(true);
          otherwise = yield* this.body(["elsif", "else", `end${tag}`], depth + 1, loop);
          if (tag === "unless") {
            while (this.tag() === "else" || this.tag() === "elsif") {
              this.pos++;
              yield* this.body(["elsif", "else", "endunless"], depth + 1, loop);
            }
          } else {
            const unexpected = this.tag();
            if (unexpected === "else" || unexpected === "elsif")
              throw new ParseError({
                message: unexpected === "else" ? "Duplicated else" : "Unexpected elsif after else",
                span: this.tokens[this.pos]!.span,
              });
          }
        }
        nodes.push({ _tag: "If", branches, otherwise, span: end(`end${tag}`) });
      } else if (tag === "for" || tag === "tablerow") {
        const name = e.name();
        e.need("in");
        if (
          this.recover &&
          (!e.words[e.pos] ||
            (!e.words[e.pos]!.quoted &&
              !/^[\p{L}\p{M}\p{N}_?-]+$/u.test(e.words[e.pos]!.text) &&
              !["(", "["].includes(e.words[e.pos]!.text)))
        )
          e.fail("Expected loop collection");
        const collection = e.atom();
        let limit: Expression | undefined;
        let offset: Expression | undefined;
        let reversed = false;
        let offsetContinue = false;
        let cols: Expression | undefined;
        const modifiers: ("offset" | "limit" | "reversed")[] = [];
        const recordModifier = (name: (typeof modifiers)[number]) => {
          if (!modifiers.includes(name)) modifiers.push(name);
        };
        while (e.pos < e.words.length) {
          if (e.take(",")) {
            if (e.pos === e.words.length || e.peek(",")) {
              if (this.recover) {
                e.pos = e.words.length;
                break;
              }
              e.fail("Unsupported loop option");
            }
            continue;
          }
          if (tag === "tablerow" && e.take("cols")) {
            e.need(":");
            cols = this.recover
              ? (e.optionalValue() ?? { _tag: "Literal", value: true, span: t.span })
              : e.atom();
          } else if (tag === "for" && e.take("reversed")) {
            if (this.dialect === "ruby" && modifiers.length)
              e.fail("reversed must precede named options");
            reversed = true;
            recordModifier("reversed");
          } else if (e.take("limit")) {
            e.need(":");
            limit = this.recover
              ? (e.optionalValue() ?? { _tag: "Literal", value: true, span: t.span })
              : e.atom();
            recordModifier("limit");
          } else if (e.take("offset")) {
            e.need(":");
            offset = this.recover
              ? (e.optionalValue() ?? { _tag: "Literal", value: true, span: t.span })
              : e.atom();
            recordModifier("offset");
            if (
              offset._tag === "Lookup" &&
              offset.root === "continue" &&
              offset.segments.length === 0
            ) {
              if (tag === "tablerow") e.fail("offset:continue is only supported for for loops");
              offsetContinue = true;
              offset = undefined;
            } else offsetContinue = false;
          } else if (this.recover) {
            if (
              !e.words[e.pos] ||
              e.words[e.pos]!.quoted ||
              !/^[\p{L}\p{M}\p{N}_?-]+$/u.test(e.words[e.pos]!.text)
            ) {
              e.pos = e.words.length;
              break;
            }
            e.name();
            if (e.take(":")) e.atom();
          } else e.fail("Unsupported loop option");
        }
        if (tag === "tablerow") {
          const body = yield* this.body(["endtablerow"], depth + 1, true);
          nodes.push({
            _tag: "TableRow",
            name,
            loopName: `${name}-${t.text.slice(collection.span.start - t.offset, collection.span.end - t.offset)}`,
            collection,
            ...(limit ? { limit } : {}),
            ...(offset ? { offset } : {}),
            ...(cols ? { cols } : {}),
            body,
            span: end("endtablerow"),
          });
          continue;
        }
        const body = yield* this.body(["else", "endfor"], depth + 1, true);
        let otherwise: Node[] = [];
        if (this.tag() === "else") {
          const b = new Expressions(
            this.tokens[this.pos++]!,
            this.maxDepth,
            this.groupedExpressions,
            this.dialect,
            this.errorMode === "strict2",
            this.recover,
          );
          b.need("else");
          b.done(true);
          otherwise = yield* this.body(["endfor"], depth + 1, true);
        }
        const collectionText = t.text.slice(
          collection.span.start - t.offset,
          collection.span.end - t.offset,
        );
        nodes.push({
          _tag: "For",
          key: JSON.stringify([name, collectionText]),
          loopName: `${name}-${collectionText}`,
          ...(offsetContinue ? { offsetContinue } : {}),
          name,
          collection,
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
          reversed,
          ...(this.orderedFilterParameters ? { modifiers } : {}),
          body,
          otherwise,
          span: end("endfor"),
        });
      } else if (tag === "case") {
        const expression = this.recover ? e.pipeline(true) : e.atom();
        e.done();
        const leading = yield* this.body(["when", "else", "endcase"], depth + 1, loop);
        if (!this.recover && leading.some((n) => n._tag !== "Text" || n.value.trim()))
          e.fail("Only whitespace is allowed before when");
        const branches: { values: Expression[]; body: Node[] }[] = [];
        if (this.dialect === "ruby") {
          while (this.tag() === "when" || this.tag() === "else") {
            const b = new Expressions(
              this.tokens[this.pos++]!,
              this.maxDepth,
              this.groupedExpressions,
              this.dialect,
              this.errorMode === "strict2",
              this.recover,
            );
            const name = b.name(),
              values: Expression[] = [];
            if (name === "when") {
              values.push(b.atom());
              while (b.take(",") || b.take("or")) values.push(b.atom());
            }
            b.done();
            branches.push({
              values,
              body: yield* this.body(["when", "else", "endcase"], depth + 1, loop),
            });
          }
          nodes.push({ _tag: "Case", expression, branches, otherwise: [], span: end("endcase") });
          continue;
        }
        while (this.tag() === "when") {
          const b = new Expressions(
            this.tokens[this.pos++]!,
            this.maxDepth,
            this.groupedExpressions,
            this.dialect,
            this.errorMode === "strict2",
            this.recover,
          );
          b.need("when");
          const values = this.recover && b.pos === b.words.length ? [] : [b.atom()];
          while (b.take(",") || b.take("or")) {
            if (this.recover && b.pos === b.words.length) break;
            values.push(b.atom());
          }
          b.done();
          branches.push({
            values,
            body: yield* this.body(["when", "else", "endcase"], depth + 1, loop),
          });
        }
        let otherwise: Node[] = [];
        if (this.tag() === "else") {
          const b = new Expressions(
            this.tokens[this.pos++]!,
            this.maxDepth,
            this.groupedExpressions,
            this.dialect,
            this.errorMode === "strict2",
            this.recover,
          );
          b.need("else");
          b.done();
          otherwise = yield* this.body(["else", "when", "endcase"], depth + 1, loop);
          let elseCount = 1;
          while (this.tag() === "else" || this.tag() === "when") {
            const tag = this.tag();
            this.pos++;
            if (tag === "else") elseCount++;
            const body = yield* this.body(["else", "when", "endcase"], depth + 1, loop);
            if (tag === "when" && elseCount === 1) otherwise.push(...body);
          }
        }
        nodes.push({ _tag: "Case", expression, branches, otherwise, span: end("endcase") });
      } else if (tag === "break" || tag === "continue") {
        e.done();
        nodes.push({ _tag: tag === "break" ? "Break" : "Continue", span: t.span });
      } else if (tag === "ifchanged" && this.dialect === "ruby") {
        e.done();
        const body = yield* this.body(["endifchanged"], depth + 1, loop);
        nodes.push({ _tag: "IfChanged", body, span: end("endifchanged") });
      } else if (tag === "block") {
        const name = e.pos < e.words.length ? e.name() : "";
        e.done();
        const body = yield* this.body(["endblock"], depth + 1, loop);
        nodes.push({ _tag: "Block", name, body, span: end("endblock") });
      } else if (tag === "layout") {
        const template = e.take("none") ? undefined : e.atom(false);
        const args: Record<string, Expression> = Object.create(null);
        while (e.pos < e.words.length) {
          e.take(",");
          const name = e.name();
          e.need(":");
          if (!this.recover && Object.hasOwn(args, name))
            e.fail(`Duplicate layout argument: ${name}`);
          args[name] = e.atom();
        }
        e.done();
        const body = yield* this.body([], depth + 1, loop);
        nodes.push({
          _tag: "Layout",
          ...(template ? { template } : {}),
          args,
          body,
          span: span(t.span.sourceId, t.span.start, body.at(-1)?.span.end ?? t.span.end),
        });
      } else if (tag === "render" || tag === "include") {
        if (this.recover && !e.words[e.pos]) e.fail("Expected template name");
        const template = e.atom(false);
        if (
          this.dialect === "ruby" &&
          tag === "render" &&
          (template._tag !== "Literal" || typeof template.value !== "string")
        )
          e.fail("Render requires a literal template name");
        const args: Record<string, Expression> = Object.create(null);
        let withBinding: PartialBinding | undefined;
        let forBinding: PartialBinding | undefined;
        while (e.pos < e.words.length) {
          e.take(",");
          if (
            this.recover &&
            (!e.words[e.pos] ||
              e.words[e.pos]!.quoted ||
              !/^[\p{L}\p{M}\p{N}_?-]+$/u.test(e.words[e.pos]!.text))
          ) {
            e.pos = e.words.length;
            break;
          }
          const name = e.name();
          if (
            tag === "include" &&
            this.dialect === "liquidjs" &&
            !(name === "with" && !withBinding && Object.keys(args).length === 0 && !e.peek(":"))
          ) {
            args[name] = e.take(":")
              ? this.recover
                ? (e.optionalValue() ?? { _tag: "Literal", value: true, span: t.span })
                : e.atom()
              : { _tag: "Literal", value: true, span: t.span };
          } else if ((name === "with" || name === "for") && !e.peek(":")) {
            let value: Expression;
            if (this.recover && !e.words[e.pos]) {
              args[name] = { _tag: "Literal", value: true, span: t.span };
              continue;
            }
            try {
              const candidate = this.recover ? e.optionalValue() : e.atom();
              if (!candidate) {
                args[name] = { _tag: "Literal", value: true, span: t.span };
                continue;
              }
              value = candidate;
              if (
                tag === "include" &&
                name === "for" &&
                ((value._tag === "Lookup" &&
                  (value.root === "contains" ||
                    value.segments.some(
                      (segment) =>
                        segment._tag === "Literal" &&
                        typeof segment.value === "number" &&
                        t.text[segment.span.start - t.offset - 1] === ".",
                    ))) ||
                  (value._tag === "SelfLookup" &&
                    value.segments[0]?._tag === "Literal" &&
                    typeof value.segments[0].value !== "string"))
              )
                e.fail("Invalid include collection");
            } catch (error) {
              if (tag === "include" && name === "for" && error instanceof ParseError)
                e.fail("Expected ':'");
              throw error;
            }
            const alias =
              (tag !== "include" || this.dialect === "ruby") && e.take("as") ? e.name() : undefined;
            const binding = { value, ...(alias ? { alias } : {}) };
            if (name === "with") {
              if (!this.recover && withBinding) e.fail("Duplicate with binding");
              withBinding = binding;
            } else {
              if (!this.recover && forBinding) e.fail("Duplicate for binding");
              forBinding = binding;
            }
          } else {
            if (this.recover && !e.take(":")) {
              args[name] = { _tag: "Literal", value: true, span: t.span };
              continue;
            }
            if (!this.recover) e.need(":");
            if (!this.recover && Object.hasOwn(args, name))
              e.fail(`Duplicate partial argument: ${name}`);
            args[name] = this.recover
              ? (e.optionalValue() ?? { _tag: "Literal", value: true, span: t.span })
              : e.atom();
          }
        }
        e.done();
        nodes.push({
          _tag: "Partial",
          mode: tag,
          template,
          args,
          ...(withBinding ? { with: withBinding } : {}),
          ...(forBinding ? { for: forBinding } : {}),
          span: t.span,
        });
      } else if (tag === "raw" || tag === "comment") {
        e.fail(`Invalid ${tag} syntax`);
      } else e.fail(`Unsupported tag '${tag}'`);
    }
    return nodes;
  }
}
const parseSyntax = (
  input: string | Source,
  options: ParseOptions = {},
  recover = false,
): Effect.Effect<Document, ParseError> =>
  Effect.gen(function* () {
    const source = typeof input === "string" ? make(input) : input;
    const tokens = yield* lex(source, options, recover);
    const iterator = new Templates(
      tokens,
      Math.min(options.maxDepth ?? 128, 256),
      {
        remaining: (options.maxTokens ?? 100_000) - tokens.length,
      },
      options.groupedExpressions,
      options.orderedFilterParameters,
      options.dialect,
      options.errorMode,
      recover,
    ).body();
    let result: IteratorResult<void, Node[]>;
    do {
      result = yield* Effect.try({
        try: () => {
          let next = iterator.next();
          for (let i = 1; i < 256 && !next.done; i++) next = iterator.next();
          return next;
        },
        catch: (error) => {
          if (error instanceof ParseError) return error;
          throw error;
        },
      });
      if (!result.done) yield* Effect.yieldNow();
    } while (!result.done);
    const blank = (body: readonly Node[]): boolean =>
      body.every((n) =>
        n._tag === "Text"
          ? !n.raw && !n.value.trim()
          : n._tag === "Assign" ||
            n._tag === "Capture" ||
            (n._tag === "If" && n.branches.every((b) => blank(b.body)) && blank(n.otherwise)) ||
            (n._tag === "For" && blank(n.body) && blank(n.otherwise)) ||
            (n._tag === "Case" && n.branches.every((b) => blank(b.body)) && blank(n.otherwise)),
      );
    const suppress = (body: readonly Node[]): Node[] =>
      body.map((n) => {
        if (n._tag === "If") {
          const empty = n.branches.every((b) => blank(b.body)) && blank(n.otherwise);
          return {
            ...n,
            branches: n.branches.map((b) => ({
              ...b,
              body: suppress(empty ? b.body.filter((x) => x._tag !== "Text") : b.body),
            })),
            otherwise: suppress(empty ? n.otherwise.filter((x) => x._tag !== "Text") : n.otherwise),
          };
        }
        if (n._tag === "Case") {
          const empty = n.branches.every((b) => blank(b.body)) && blank(n.otherwise);
          return {
            ...n,
            branches: n.branches.map((b) => ({
              ...b,
              body: suppress(empty ? b.body.filter((x) => x._tag !== "Text") : b.body),
            })),
            otherwise: suppress(empty ? n.otherwise.filter((x) => x._tag !== "Text") : n.otherwise),
          };
        }
        if (n._tag === "For") {
          const empty = blank(n.body) && blank(n.otherwise);
          return {
            ...n,
            body: suppress(empty ? n.body.filter((x) => x._tag !== "Text") : n.body),
            otherwise: suppress(empty ? n.otherwise.filter((x) => x._tag !== "Text") : n.otherwise),
          };
        }
        return n;
      });
    const body = options.dialect === "ruby" ? suppress(result.value) : result.value;
    return {
      _tag: "Document" as const,
      ...(recover ? { recovered: true as const } : {}),
      dialect: options.dialect ?? "liquidjs",
      ...(options.errorMode ? { errorMode: options.errorMode } : {}),
      ...(options.parseLimit === undefined ? {} : { parseLimit: options.parseLimit }),
      source,
      body,
      ...(options.groupedExpressions ? { groupedExpressions: true } : {}),
      ...(options.orderedFilterParameters ? { orderedFilterParameters: true } : {}),
      ...(delimiterKeys.some((key) => options[key] !== undefined)
        ? {
            delimiters: Object.fromEntries(
              delimiterKeys
                .filter((key) => options[key] !== undefined)
                .map((key) => [key, options[key]]),
            ),
          }
        : {}),
      ...(whitespaceKeys.some((key) => options[key] !== undefined)
        ? {
            whitespace: Object.fromEntries(
              whitespaceKeys
                .filter((key) => options[key] !== undefined)
                .map((key) => [key, options[key]]),
            ),
          }
        : {}),
    };
  }).pipe(Effect.withSpan("liquid.parse"));
export type { ParseOptions } from "./Lexer.js";

export const parse = (
  input: string | Source,
  options: ParseOptions = {},
): Effect.Effect<Document, ParseError> =>
  parseSyntax(input, options).pipe(
    Effect.catchAll((error) =>
      options.dialect === "ruby" || /limit|Unsupported tag/.test(error.message)
        ? Effect.fail(error)
        : parseSyntax(input, options, true),
    ),
  );
