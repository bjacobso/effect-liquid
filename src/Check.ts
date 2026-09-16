import { Effect } from "effect";
import { path } from "./Analyze.js";
import type { Document, Expression, Node } from "./Ast.js";
import * as Binding from "./Binding.js";
import { registry as builtins } from "./Builtins.js";
import type { BuiltinFilterError, Diagnostic } from "./Diagnostic.js";
import { ParseError } from "./Diagnostic.js";
import { embeddedExpression } from "./EmbeddedExpression.js";
import type { Registry } from "./Filter.js";
import type { Span } from "./Source.js";
import * as T from "./Type.js";
export interface CheckOptions {
  readonly mode?: "strict" | "compatibility";
}
export interface CheckResult {
  readonly passed: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: "complete" | "partial";
  readonly coverageReasons: readonly string[];
  readonly expressionTypes: Readonly<Record<string, T.Type>>;
}
export const check = <E = never, R = never>(
  document: Document,
  contract: T.Type,
  options: CheckOptions = {},
  registry: Registry<E | BuiltinFilterError, R> = builtins,
): Effect.Effect<CheckResult> =>
  Effect.sync((): CheckResult => {
    const expressionTypes: Record<string, T.Type> = Object.create(null);
    const diagnostics: Diagnostic[] = [];
    const reasons = new Set<string>();
    let embeddedDepth = 0;
    const strict = options.mode !== "compatibility";
    const report = (
      code: string,
      message: string,
      span: Span,
      severity: "error" | "warning" = "error",
    ) => diagnostics.push({ code, message, span, severity });
    const unknown = (reason: string, span: Span) => {
      reasons.add(reason);
      report("UnknownCoverage", reason, span, strict ? "error" : "warning");
      return T.unknown;
    };
    const property = (type: T.Type, key: T.Type, at: Span, guard = false): T.Type =>
      T.union(
        ...T.members(type).map((t) => {
          if (t._tag === "Unknown") return unknown("Unknown receiver type", at);
          if (t._tag === "Nil" || t._tag === "Missing") {
            if (!guard)
              report("OptionalAccess", "Receiver may be absent", at, strict ? "error" : "warning");
            return T.missing;
          }
          if (t._tag === "Record") {
            if (key._tag === "Literal") {
              const k = String(key.value);
              const field = Object.getOwnPropertyDescriptor(t.fields, k)?.value as
                | T.Type
                | undefined;
              if (field) return field;
              if (t.index) return t.index;
              report("UnknownProperty", `Unknown property '${k}'`, at);
              return T.unknown;
            }
            if (t.index) return t.index;
            return unknown("Computed record key cannot be resolved", at);
          }
          if (
            t._tag === "Array" ||
            t._tag === "Tuple" ||
            t._tag === "String" ||
            (t._tag === "Literal" && typeof t.value === "string")
          ) {
            if (key._tag === "Literal" && key.value === "size") return T.number;
            if (key._tag === "Literal" && (key.value === "first" || key.value === "last"))
              return t._tag === "Array"
                ? T.optional(t.item)
                : t._tag === "Tuple"
                  ? T.optional(T.union(...t.items))
                  : T.unknown;
            if (!T.members(key).every((k) => T.kind(k) === "number")) {
              report("InvalidIndex", "Expected numeric index", at);
              return T.unknown;
            }
            return t._tag === "Array"
              ? T.optional(t.item)
              : t._tag === "Tuple"
                ? T.optional(
                    key._tag === "Literal"
                      ? (t.items[Number(key.value)] ?? T.missing)
                      : T.union(...t.items),
                  )
                : T.optional(T.string);
          }
          report("InvalidReceiver", `Cannot access a property on ${T.kind(t)}`, at);
          return T.unknown;
        }),
      );
    const inferRaw = (e: Expression, env: Binding.Flow<T.Type>, guard = false): T.Type => {
      switch (e._tag) {
        case "Literal":
          return e.value === null ? T.nil : T.literal(e.value);
        case "Special":
          return T.unknown;
        case "Lookup": {
          const refined = env.locals.get(`@${path(e)}`);
          if (refined) return refined;
          let type =
            env.locals.get(`@${e.root}`) ??
            Binding.read(env, e.root) ??
            property(contract, T.literal(e.root), e.span, guard);
          for (let i = 0; i < e.segments.length; i++) {
            const segment = e.segments[i]!;
            const prefix = path({ ...e, segments: e.segments.slice(0, i + 1) });
            type =
              env.locals.get(`@${prefix}`) ??
              property(type, infer(segment, env), segment.span, guard);
          }
          if (!guard && T.members(type).some((t) => t._tag === "Missing" || t._tag === "Nil"))
            report(
              "OptionalValue",
              `'${path(e)}' may be absent`,
              e.span,
              strict ? "error" : "warning",
            );
          if (type._tag === "Unknown") unknown(`Unknown type for '${path(e)}'`, e.span);
          return type;
        }
        case "Range":
          infer(e.from, env);
          infer(e.to, env);
          return T.array(T.number);
        case "Not":
          infer(e.value, env, true);
          return T.boolean;
        case "Binary": {
          const left = infer(e.left, env, true);
          const right = infer(e.right, env, true);
          if (
            [">", "<", ">=", "<="].includes(e.operator) &&
            !T.members(left).every((a) =>
              T.members(right).every(
                (b) => T.kind(a) === T.kind(b) && ["number", "string"].includes(T.kind(a)),
              ),
            )
          )
            report(
              "InvalidComparison",
              "Comparison requires compatible strings or numbers",
              e.span,
            );
          return T.boolean;
        }
        case "Filter": {
          const input = infer(e.input, env, e.name === "default");
          const args = e.args.map((a) => infer(a, env));
          for (const a of Object.values(e.named)) infer(a, env);
          const signature = registry.filters.get(e.name)?.signature;
          if (!signature) return unknown(`Missing filter signature: ${e.name}`, e.span);
          if (args.length < signature.minArgs || args.length > signature.maxArgs)
            report("FilterArity", `Invalid argument count for '${e.name}'`, e.span);
          if (
            strict &&
            signature.input !== "any" &&
            !T.members(input).every((t) => T.kind(t) === signature.input)
          )
            report("FilterInput", `'${e.name}' expects ${signature.input}`, e.input.span);
          args.forEach((argument, index) => {
            const expected = signature.positionalArguments?.[index] ?? signature.argument;
            if (
              expected &&
              expected !== "any" &&
              !T.members(argument).every((t) => T.kind(t) === expected)
            )
              report(
                "FilterArgument",
                `'${e.name}' expects ${expected} at argument ${index + 1}`,
                e.args[index]!.span,
                strict ? "error" : "warning",
              );
          });
          const filter = registry.filters.get(e.name);
          if (filter && "expression" in filter) {
            const item = T.union(
              ...T.members(input).map((t) => {
                if (t._tag === "Array") return t.item;
                if (t._tag === "Tuple") return T.union(...t.items);
                if (t._tag === "Nil" || t._tag === "Missing") return T.never;
                if (filter.expression === "group_by") {
                  if (t._tag === "Record")
                    return T.tuple(
                      T.string,
                      T.union(...Object.values(t.fields), t.index ?? T.never),
                    );
                  if (t._tag !== "String" && !(t._tag === "Literal" && typeof t.value === "string"))
                    return T.unknown;
                }
                return t;
              }),
            );
            const alias = e.args[0],
              predicate = e.args[1];
            if (
              embeddedDepth >= 32 ||
              alias?._tag !== "Literal" ||
              typeof alias.value !== "string" ||
              predicate?._tag !== "Literal" ||
              typeof predicate.value !== "string"
            )
              return unknown("Dynamic or deeply nested filter predicate", e.span);
            const next = Binding.fork(env);
            next.locals.set(alias.value, item);
            for (const name of next.locals.keys())
              if (
                name === `@${alias.value}` ||
                name.startsWith(`@${alias.value}.`) ||
                name.startsWith(`@${alias.value}[`)
              )
                next.locals.delete(name);
            let key: T.Type;
            embeddedDepth++;
            try {
              key = infer(embeddedExpression(predicate.value, predicate.span), next);
            } catch (error) {
              if (!(error instanceof ParseError)) throw error;
              return unknown(`Invalid filter predicate: ${error.message}`, predicate.span);
            } finally {
              embeddedDepth--;
            }
            if (filter.expression === "where" || filter.expression === "reject")
              return T.array(item);
            if (filter.expression === "find") return T.optional(item);
            if (filter.expression === "has") return T.boolean;
            if (filter.expression === "find_index") return T.optional(T.number);
            return T.array(T.record({ name: key, items: T.array(item) }));
          }
          if (e.name === "default")
            return T.union(
              T.present(input),
              ...(e.named.allow_false ? [input] : []),
              args[0] ?? T.nil,
            );
          if (e.name === "map") {
            const name = e.args[0];
            const keys =
              name?._tag === "Literal" && typeof name.value === "string"
                ? name.value.split(".")
                : undefined;
            if (!keys) return unknown("Dynamic or unsupported map property path", e.span);
            return T.array(
              T.union(
                ...T.members(input).map((t) => {
                  const item =
                    t._tag === "Array" ? t.item : t._tag === "Tuple" ? T.union(...t.items) : t;
                  return keys.reduce((value, key) => property(value, T.literal(key), e.span), item);
                }),
              ),
            );
          }
          if (e.name === "first" || e.name === "last")
            return T.optional(
              T.union(
                ...T.members(input).map((t) =>
                  t._tag === "Array"
                    ? t.item
                    : t._tag === "Tuple"
                      ? T.union(...t.items)
                      : unknown("Unknown collection element type", e.span),
                ),
              ),
            );
          switch (signature.output) {
            case "string":
              return T.string;
            case "number":
              return T.number;
            case "array":
              if (e.name === "split") return T.array(T.string);
              if (e.name === "reverse") return input;
              return unknown(`Unknown element type after '${e.name}'`, e.span);
            case "input":
              return input;
            default:
              return unknown(`Unknown result type for '${e.name}'`, e.span);
          }
        }
      }
    };
    const infer = (e: Expression, env: Binding.Flow<T.Type>, guard = false): T.Type => {
      const type = inferRaw(e, env, guard);
      expressionTypes[`${e.span.start}:${e.span.end}`] = type;
      return type;
    };
    const narrow = (e: Expression, env: Binding.Flow<T.Type>): void => {
      if (e._tag === "Lookup") {
        const type = T.present(infer(e, env, true));
        env.locals.set(`@${path(e)}`, type);
      } else if (e._tag === "Binary" && e.operator === "and") {
        narrow(e.left, env);
        narrow(e.right, env);
      }
    };
    const merge = (types: readonly (T.Type | undefined)[]) =>
      T.union(...types.map((t) => t ?? T.missing));
    const body = (nodes: readonly Node[], env: Binding.Flow<T.Type>): void => {
      for (const n of nodes)
        switch (n._tag) {
          case "Text":
            break;
          case "Break":
          case "Continue":
            unknown("Loop control flow requires a fixed-point summary", n.span);
            break;
          case "Output":
            infer(n.expression, env);
            break;
          case "Counter":
            if (!env.values.has(n.name)) {
              env.values.set(n.name, T.number);
              for (const key of env.locals.keys())
                if (
                  key === `@${n.name}` ||
                  key.startsWith(`@${n.name}.`) ||
                  key.startsWith(`@${n.name}[`)
                )
                  env.locals.delete(key);
            }
            break;
          case "Cycle":
            if (n.group) infer(n.group, env);
            for (const value of n.values) infer(value, env);
            break;
          case "Assign": {
            const type = infer(n.expression, env);
            env.values.set(n.name, type);
            for (const key of env.locals.keys()) if (key.startsWith("@")) env.locals.delete(key);
            break;
          }
          case "Capture":
            body(n.body, env);
            env.values.set(n.name, T.string);
            for (const key of env.locals.keys()) if (key.startsWith("@")) env.locals.delete(key);
            break;
          case "If": {
            const branches = n.branches.map((b) => {
              infer(b.condition, env, true);
              const next = Binding.fork(env);
              narrow(b.condition, next);
              body(b.body, next);
              return next;
            });
            const otherwise = Binding.fork(env);
            body(n.otherwise, otherwise);
            Binding.join(env, [...branches, otherwise], merge);
            break;
          }
          case "Case": {
            infer(n.expression, env);
            const branches = n.branches.map((b) => {
              for (const e of b.values) infer(e, env);
              const next = Binding.fork(env);
              body(b.body, next);
              return next;
            });
            const otherwise = Binding.fork(env);
            body(n.otherwise, otherwise);
            Binding.join(env, [...branches, otherwise], merge);
            break;
          }
          case "For":
          case "TableRow": {
            const type = infer(n.collection, env);
            if (n.limit) infer(n.limit, env);
            if (n.offset) infer(n.offset, env);
            if (n._tag === "TableRow" && n.cols) infer(n.cols, env);
            const next = Binding.fork(env);
            const item = T.union(
              ...T.members(type).map((t) =>
                t._tag === "Array"
                  ? t.item
                  : t._tag === "Tuple"
                    ? T.union(...t.items)
                    : unknown("Unknown loop element type", n.span),
              ),
            );
            next.locals.set(n.name, item);
            next.locals.set(
              n._tag === "TableRow" ? "tablerowloop" : "forloop",
              T.record({
                index: T.number,
                index0: T.number,
                rindex: T.number,
                rindex0: T.number,
                first: T.boolean,
                last: T.boolean,
                length: T.number,
                ...(n._tag === "TableRow"
                  ? {
                      col: T.number,
                      col0: T.number,
                      row: T.number,
                      col_first: T.boolean,
                      col_last: T.boolean,
                    }
                  : { parentloop: T.unknown }),
              }),
            );
            body(n.body, next);
            if ([...next.values].some(([name, type]) => type !== env.values.get(name)))
              unknown("Loop-carried assignment types require a fixed-point summary", n.span);
            const otherwise = Binding.fork(env);
            if (n._tag === "For") body(n.otherwise, otherwise);
            Binding.join(env, [next, otherwise], merge);
            break;
          }
          case "Partial":
            infer(n.template, env);
            for (const e of Object.values(n.args)) infer(e, env);
            if (n.with) infer(n.with.value, env);
            if (n.for) infer(n.for.value, env);
            unknown("Partial contract has not been checked", n.span);
            break;
        }
    };
    body(document.body, Binding.make());
    const sorted = [
      ...new Map(diagnostics.map((d) => [`${d.code}:${d.span.start}:${d.message}`, d])).values(),
    ].sort((a, b) => a.span.start - b.span.start);
    return {
      passed: !sorted.some((d) => d.severity === "error"),
      diagnostics: sorted,
      coverage: reasons.size ? "partial" : "complete",
      coverageReasons: [...reasons],
      expressionTypes,
    };
  }).pipe(Effect.withSpan("liquid.check"));
