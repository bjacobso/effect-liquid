import type { Expression } from "./Ast.js";
import { ParseError } from "./Diagnostic.js";
import type { Token } from "./Lexer.js";
import { type Source, span } from "./Source.js";

interface Word {
  text: string;
  start: number;
  end: number;
  quoted?: boolean;
}
const identifier = /^[\p{L}_][\p{L}\p{M}\p{N}_-]*$/u;
const property = /^[\p{L}\p{M}\p{N}_-]+\??$/u;
export class Expressions {
  readonly words: Word[] = [];
  pos = 0;
  depth = 0;
  constructor(
    readonly token: Token,
    readonly maxDepth: number,
    readonly groupedExpressions = false,
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
    if (!w || w.quoted || !identifier.test(w.text)) this.fail("Expected identifier", w?.start);
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
  suffix(): Expression[] {
    const segments: Expression[] = [];
    while (this.peek(".") || this.peek("[")) {
      if (this.take(".")) {
        const key = this.words[this.pos++];
        if (!key || key.quoted || !property.test(key.text)) this.fail("Expected property");
        segments.push({ _tag: "Literal", value: key.text, span: this.position(key.start) });
      } else {
        this.need("[");
        segments.push(this.atom());
        this.need("]");
      }
    }
    return segments;
  }
  atom(literalAccess = true): Expression {
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
      const from = this.groupedExpressions ? this.pipeline(true) : this.atom();
      if (this.take("..")) {
        const to = this.atom();
        this.need(")");
        result = { _tag: "Range", from, to, span: this.position(w.start) };
      } else {
        if (!this.groupedExpressions) this.fail("Expected '..'");
        this.need(")");
        result = from;
      }
    } else if (w.text === "[") {
      const segments: Expression[] = [this.atom()];
      this.need("]");
      segments.push(...this.suffix());
      result = { _tag: "SelfLookup", segments, span: this.position(w.start) };
    } else {
      if (!identifier.test(w.text)) this.fail("Expected variable or literal", w.start);
      const segments = this.suffix();
      result = { _tag: "Lookup", root: w.text, segments, span: this.position(w.start) };
    }
    if (literalAccess && (result._tag === "Literal" || result._tag === "Special")) {
      const segments = this.suffix();
      if (segments.length)
        result = { _tag: "Access", receiver: result, segments, span: this.position(w.start) };
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
  pipeline(condition = false): Expression {
    let input = condition ? this.condition() : this.atom();
    let filters = 0;
    while (this.take("|")) {
      if (++filters > this.maxDepth) this.fail("Filter nesting limit exceeded");
      const name = this.name();
      const args: Expression[] = [];
      const named: Record<string, Expression> = Object.create(null);
      if (this.take(":") && this.pos < this.words.length && !this.peek("|"))
        do {
          if (this.words[this.pos + 1]?.text === ":" && !this.words[this.pos]?.quoted) {
            const key = this.name();
            this.need(":");
            if (Object.hasOwn(named, key)) this.fail(`Duplicate filter argument: ${key}`);
            named[key] = this.atom();
          } else args.push(this.atom());
        } while (this.take(",") && this.pos < this.words.length && !this.peek("|"));
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
/** Parse an expression string without executing it or rewriting it as a template. */
export function readExpression(source: Source, groupedExpressions = false): Expression {
  if (source.text.length > 1_000_000)
    throw new ParseError({
      message: "Expression source limit exceeded",
      span: span(source.id, 0, source.text.length),
    });
  const parser = new Expressions(
    { kind: "output", text: source.text, offset: 0, span: span(source.id, 0, source.text.length) },
    128,
    groupedExpressions,
  );
  const expression = parser.pipeline(true);
  parser.done();
  return expression;
}
