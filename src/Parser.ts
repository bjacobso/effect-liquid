import { Effect } from "effect";
import type { Document, Expression, Node, PartialBinding } from "./Ast.js";
import { ParseError } from "./Diagnostic.js";
import { lex, type ParseOptions, type Token } from "./Lexer.js";
import { make, type Source, span } from "./Source.js";

interface Word {
  text: string;
  start: number;
  end: number;
  quoted?: boolean;
}
class Expressions {
  readonly words: Word[] = [];
  pos = 0;
  depth = 0;
  constructor(
    readonly token: Token,
    readonly maxDepth: number,
  ) {
    const s = token.text;
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i]!)) {
        i++;
        continue;
      }
      const start = i;
      const ch = s[i]!;
      if (ch === "'" || ch === '"') {
        i++;
        let value = "";
        while (i < s.length && s[i] !== ch) {
          if (s[i] === "\\" && (s[i + 1] === ch || s[i + 1] === "\\")) i++;
          value += s[i++]!;
        }
        if (i === s.length) this.fail("Unclosed string", start);
        i++;
        this.words.push({ text: value, start, end: i, quoted: true });
        continue;
      }
      const pair = s.slice(i, i + 2);
      if (["..", "==", "!=", ">=", "<="].includes(pair)) {
        i += 2;
        this.words.push({ text: pair, start, end: i });
        continue;
      }
      if ("[]().,:|=<>".includes(ch)) {
        i++;
        this.words.push({ text: ch, start, end: i });
        continue;
      }
      const number = /^-?\d+(?:\.(?!\.)\d+)?/.exec(s.slice(i));
      if (number) i += number[0].length;
      else while (i < s.length && !/[\s[\]().,:|=<>]/.test(s[i]!)) i++;
      if (i === start) this.fail("Unexpected character", i);
      this.words.push({ text: s.slice(start, i), start, end: i });
    }
  }
  fail(message: string, position = this.words[this.pos]?.start ?? this.token.text.length): never {
    throw new ParseError({
      message,
      span: span(
        this.token.span.sourceId,
        this.token.offset + position,
        this.token.offset + position + 1,
      ),
    });
  }
  peek(text: string) {
    return !this.words[this.pos]?.quoted && this.words[this.pos]?.text === text;
  }
  take(text: string) {
    if (this.peek(text)) {
      this.pos++;
      return true;
    }
    return false;
  }
  need(text: string) {
    if (!this.take(text)) this.fail(`Expected '${text}'`);
  }
  name() {
    const w = this.words[this.pos++];
    if (!w || w.quoted || !/^[a-zA-Z_][\w-]*$/.test(w.text))
      this.fail("Expected identifier", w?.start);
    return w.text;
  }
  done() {
    if (this.pos !== this.words.length) this.fail(`Unexpected '${this.words[this.pos]!.text}'`);
  }
  position(start: number) {
    return span(
      this.token.span.sourceId,
      this.token.offset + start,
      this.token.offset + (this.words[this.pos - 1]?.end ?? start),
    );
  }
  atom(): Expression {
    if (++this.depth > this.maxDepth) this.fail("Expression nesting limit exceeded");
    const w = this.words[this.pos++];
    if (!w) this.fail("Expected expression");
    let result: Expression;
    if (w.quoted) result = { _tag: "Literal", value: w.text, span: this.position(w.start) };
    else if (/^-?\d+(?:\.\d+)?$/.test(w.text)) {
      const value = Number(w.text);
      if (!Number.isFinite(value)) this.fail("Non-finite numeric literal", w.start);
      result = { _tag: "Literal", value, span: this.position(w.start) };
    } else if (["nil", "null", "true", "false"].includes(w.text))
      result = {
        _tag: "Literal",
        value: w.text === "true" ? true : w.text === "false" ? false : null,
        span: this.position(w.start),
      };
    else if (w.text === "empty" || w.text === "blank")
      result = { _tag: "Special", value: w.text, span: this.position(w.start) };
    else if (w.text === "(") {
      const from = this.atom();
      this.need("..");
      const to = this.atom();
      this.need(")");
      result = { _tag: "Range", from, to, span: this.position(w.start) };
    } else {
      if (!/^[a-zA-Z_][\w-]*$/.test(w.text)) this.fail("Expected variable or literal", w.start);
      const segments: Expression[] = [];
      while (this.peek(".") || this.peek("[")) {
        if (this.take(".")) {
          const key = this.words[this.pos++];
          if (!key || key.quoted || !/^[\w-]+$/.test(key.text)) this.fail("Expected property");
          segments.push({ _tag: "Literal", value: key.text, span: this.position(key.start) });
        } else {
          this.need("[");
          segments.push(this.atom());
          this.need("]");
        }
      }
      result = { _tag: "Lookup", root: w.text, segments, span: this.position(w.start) };
    }
    this.depth--;
    return result;
  }
  condition(): Expression {
    if (++this.depth > this.maxDepth) this.fail("Expression nesting limit exceeded");
    let left: Expression;
    if (this.take("not")) {
      const start = this.words[this.pos - 1]!.start;
      left = { _tag: "Not", value: this.comparison(), span: this.position(start) };
    } else left = this.comparison();
    if (this.peek("and") || this.peek("or")) {
      const operator = this.words[this.pos++]!.text;
      const right = this.condition();
      left = { _tag: "Binary", operator, left, right, span: { ...left.span, end: right.span.end } };
    }
    this.depth--;
    return left;
  }
  comparison(): Expression {
    let left = this.atom();
    if (["==", "!=", ">", "<", ">=", "<=", "contains"].some((x) => this.peek(x))) {
      const operator = this.words[this.pos++]!.text;
      const right = this.atom();
      left = { _tag: "Binary", operator, left, right, span: { ...left.span, end: right.span.end } };
    }
    return left;
  }
  pipeline(): Expression {
    let input = this.atom();
    let filters = 0;
    while (this.take("|")) {
      if (++filters > this.maxDepth) this.fail("Filter nesting limit exceeded");
      const name = this.name();
      const args: Expression[] = [];
      const named: Record<string, Expression> = Object.create(null);
      if (this.take(":"))
        do {
          if (this.words[this.pos + 1]?.text === ":" && !this.words[this.pos]?.quoted) {
            const key = this.name();
            this.need(":");
            if (Object.hasOwn(named, key)) this.fail(`Duplicate filter argument: ${key}`);
            named[key] = this.atom();
          } else args.push(this.atom());
        } while (this.take(","));
      input = {
        _tag: "Filter",
        input,
        name,
        args,
        named,
        span: { ...input.span, end: this.position(0).end },
      };
    }
    return input;
  }
}
class Templates {
  pos = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly maxDepth: number,
    readonly budget: { remaining: number },
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
        nodes.push({ _tag: "Text", value: t.text, span: t.span });
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
        const nested = yield* new Templates(lines, this.maxDepth, this.budget).body(
          [],
          depth + 1,
          loop,
        );
        for (const node of nested) nodes.push(node);
        continue;
      }
      if (t.kind === "tag" && t.text.trimStart().startsWith("#")) {
        if (/\n\s*[^#\s]/.test(t.text))
          throw new ParseError({
            message: "Every inline comment line must start with #",
            span: t.span,
          });
        continue;
      }
      if (t.kind === "tag" && t.text.trim() === "comment") {
        while (this.pos < this.tokens.length && this.tag() !== "endcomment") {
          this.pos++;
          yield;
        }
        if (this.pos === this.tokens.length)
          throw new ParseError({ message: "Unclosed comment", span: t.span });
        this.pos++;
        continue;
      }
      const e = new Expressions(t, this.maxDepth);
      if (depth > this.maxDepth) e.fail("Template nesting limit exceeded");
      if (t.kind === "output") {
        const expression = e.pipeline();
        e.done();
        nodes.push({ _tag: "Output", expression, span: t.span });
        continue;
      }
      const tag = e.name();
      const end = (name: string) => {
        const close = this.tokens[this.pos++];
        if (!close || close.text.trim() !== name) e.fail(`Expected ${name}`);
        return { ...t.span, end: close!.span.end };
      };
      if (tag === "increment" || tag === "decrement") {
        const start = e.words[e.pos]?.start ?? t.text.length;
        const name = e.name();
        e.done();
        nodes.push({
          _tag: "Counter",
          name,
          direction: tag === "increment" ? 1 : -1,
          nameSpan: e.position(start),
          span: t.span,
        });
      } else if (tag === "cycle") {
        const first = e.atom();
        const group = e.take(":") ? first : undefined;
        const values = group ? [e.atom()] : [first];
        while (e.take(",")) values.push(e.atom());
        e.done();
        const key = values
          .map((value) => t.text.slice(value.span.start - t.offset, value.span.end - t.offset))
          .join(",");
        nodes.push({ _tag: "Cycle", ...(group ? { group } : {}), values, key, span: t.span });
      } else if (tag === "assign") {
        const name = e.name();
        e.need("=");
        const expression = e.pipeline();
        e.done();
        nodes.push({ _tag: "Assign", name, expression, span: t.span });
      } else if (tag === "echo") {
        const expression = e.pipeline();
        e.done();
        nodes.push({ _tag: "Output", expression, span: t.span });
      } else if (tag === "capture") {
        const name = e.name();
        e.done();
        const body = yield* this.body(["endcapture"], depth + 1, loop);
        nodes.push({ _tag: "Capture", name, body, span: end("endcapture") });
      } else if (tag === "if" || tag === "unless") {
        let condition = e.condition();
        e.done();
        if (tag === "unless") condition = { _tag: "Not", value: condition, span: condition.span };
        const branches = [
          { condition, body: yield* this.body(["elsif", "else", `end${tag}`], depth + 1, loop) },
        ];
        while (this.tag() === "elsif") {
          const b = new Expressions(this.tokens[this.pos++]!, this.maxDepth);
          b.need("elsif");
          const condition = b.condition();
          b.done();
          branches.push({
            condition,
            body: yield* this.body(["elsif", "else", `end${tag}`], depth + 1, loop),
          });
        }
        let otherwise: Node[] = [];
        if (this.tag() === "else") {
          const b = new Expressions(this.tokens[this.pos++]!, this.maxDepth);
          b.need("else");
          b.done();
          otherwise = yield* this.body([`end${tag}`], depth + 1, loop);
        }
        nodes.push({ _tag: "If", branches, otherwise, span: end(`end${tag}`) });
      } else if (tag === "for" || tag === "tablerow") {
        const name = e.name();
        e.need("in");
        const collection = e.atom();
        let limit: Expression | undefined;
        let offset: Expression | undefined;
        let reversed = false;
        let offsetContinue = false;
        let cols: Expression | undefined;
        while (e.pos < e.words.length) {
          if (tag === "tablerow" && e.take("cols")) {
            if (cols) e.fail("Duplicate cols");
            e.need(":");
            cols = e.atom();
          } else if (tag === "for" && e.take("reversed")) {
            if (reversed) e.fail("Duplicate reversed");
            reversed = true;
          } else if (e.take("limit")) {
            if (limit) e.fail("Duplicate limit");
            e.need(":");
            limit = e.atom();
          } else if (e.take("offset")) {
            if (offset || offsetContinue) e.fail("Duplicate offset");
            e.need(":");
            offset = e.atom();
            if (
              offset._tag === "Lookup" &&
              offset.root === "continue" &&
              offset.segments.length === 0
            ) {
              if (tag === "tablerow") e.fail("offset:continue is only supported for for loops");
              offsetContinue = true;
              offset = undefined;
            }
          } else e.fail("Unsupported loop option");
        }
        if (tag === "tablerow") {
          const body = yield* this.body(["endtablerow"], depth + 1, loop);
          nodes.push({
            _tag: "TableRow",
            name,
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
          const b = new Expressions(this.tokens[this.pos++]!, this.maxDepth);
          b.need("else");
          b.done();
          otherwise = yield* this.body(["endfor"], depth + 1, loop);
        }
        nodes.push({
          _tag: "For",
          key: JSON.stringify([
            name,
            t.text.slice(collection.span.start - t.offset, collection.span.end - t.offset),
          ]),
          ...(offsetContinue ? { offsetContinue } : {}),
          name,
          collection,
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
          reversed,
          body,
          otherwise,
          span: end("endfor"),
        });
      } else if (tag === "case") {
        const expression = e.atom();
        e.done();
        const leading = yield* this.body(["when", "else", "endcase"], depth + 1, loop);
        if (leading.some((n) => n._tag !== "Text" || n.value.trim()))
          e.fail("Only whitespace is allowed before when");
        const branches: { values: Expression[]; body: Node[] }[] = [];
        while (this.tag() === "when") {
          const b = new Expressions(this.tokens[this.pos++]!, this.maxDepth);
          b.need("when");
          const values = [b.atom()];
          while (b.take(",") || b.take("or")) values.push(b.atom());
          b.done();
          branches.push({
            values,
            body: yield* this.body(["when", "else", "endcase"], depth + 1, loop),
          });
        }
        let otherwise: Node[] = [];
        if (this.tag() === "else") {
          const b = new Expressions(this.tokens[this.pos++]!, this.maxDepth);
          b.need("else");
          b.done();
          otherwise = yield* this.body(["endcase"], depth + 1, loop);
        }
        nodes.push({ _tag: "Case", expression, branches, otherwise, span: end("endcase") });
      } else if (tag === "break" || tag === "continue") {
        e.done();
        if (!loop) e.fail(`${tag} outside loop`);
        nodes.push({ _tag: tag === "break" ? "Break" : "Continue", span: t.span });
      } else if (tag === "render" || tag === "include") {
        const template = e.atom();
        if (
          template._tag === "Literal" &&
          typeof template.value === "string" &&
          template.value.includes("{{")
        )
          e.fail("Interpolated template filenames are not supported yet");
        const args: Record<string, Expression> = Object.create(null);
        let withBinding: PartialBinding | undefined;
        let forBinding: PartialBinding | undefined;
        while (e.pos < e.words.length) {
          e.take(",");
          const name = e.name();
          if ((name === "with" || (name === "for" && tag === "render")) && !e.peek(":")) {
            const value = e.atom();
            const alias = tag === "render" && e.take("as") ? e.name() : undefined;
            const binding = { value, ...(alias ? { alias } : {}) };
            if (name === "with") {
              if (withBinding) e.fail("Duplicate with binding");
              withBinding = binding;
            } else {
              if (forBinding) e.fail("Duplicate for binding");
              forBinding = binding;
            }
          } else {
            e.need(":");
            if (Object.hasOwn(args, name)) e.fail(`Duplicate partial argument: ${name}`);
            args[name] = e.atom();
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
      } else e.fail(`Unsupported tag '${tag}'`);
    }
    return nodes;
  }
}
export const parse = (
  input: string | Source,
  options: ParseOptions = {},
): Effect.Effect<Document, ParseError> =>
  Effect.gen(function* () {
    const source = typeof input === "string" ? make(input) : input;
    const tokens = yield* lex(source, options);
    const iterator = new Templates(tokens, Math.min(options.maxDepth ?? 128, 256), {
      remaining: (options.maxTokens ?? 100_000) - tokens.length,
    }).body();
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
    const body = result.value;
    return { _tag: "Document" as const, source, body };
  }).pipe(Effect.withSpan("liquid.parse"));
export type { ParseOptions } from "./Lexer.js";
