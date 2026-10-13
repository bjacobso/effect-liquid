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
    let flowWork = 0;
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
              if (field)
                return k === "size"
                  ? T.union(
                      ...T.members(field).map((member) =>
                        member._tag === "Missing" ? T.number : member,
                      ),
                    )
                  : field;
              if (k === "size") return t.index ? T.union(t.index, T.number) : T.number;
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
            if (key._tag === "Literal" && (key.value === "size" || key.value === "length"))
              return T.number;
            if (key._tag === "Literal" && (key.value === "first" || key.value === "last"))
              return t._tag === "Array"
                ? T.optional(t.item)
                : t._tag === "Tuple"
                  ? T.optional(T.union(...t.items))
                  : T.unknown;
            const indexKey = (k: T.Type) =>
              T.kind(k) === "number" ||
              (k._tag === "Literal" &&
                typeof k.value === "string" &&
                /^(?:0|[1-9]\d*)$/.test(k.value));
            if (!T.members(key).every(indexKey)) {
              report("InvalidIndex", "Expected numeric index", at);
              return T.unknown;
            }
            return t._tag === "Array"
              ? T.optional(t.item)
              : t._tag === "Tuple"
                ? T.optional(
                    key._tag === "Literal"
                      ? (t.items[
                          typeof key.value === "number" && key.value < 0
                            ? t.items.length + key.value
                            : Number(key.value)
                        ] ?? T.missing)
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
        case "Access": {
          let type = infer(e.receiver, env);
          for (const segment of e.segments)
            type = property(type, infer(segment, env), segment.span, guard);
          return type;
        }
        case "Literal":
          return e.value === null ? T.nil : T.literal(e.value);
        case "Special":
          return T.unknown;
        case "SelfLookup": {
          const [first, ...rest] = e.segments;
          if (first?._tag === "Literal" && typeof first.value === "string")
            return inferRaw(
              { _tag: "Lookup", root: first.value, segments: rest, span: e.span },
              env,
              guard,
            );
          for (const segment of e.segments) infer(segment, env);
          unknown("Dynamic context-root lookup", e.span);
          return T.unknown;
        }
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
            !T.members(input).every(
              (t) =>
                T.kind(t) === signature.input ||
                (signature.input === "array" && t._tag === "Tuple"),
            )
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
              key = infer(
                embeddedExpression(predicate.value, predicate.span, document.groupedExpressions),
                next,
              );
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
          if (e.name === "array_to_sentence_string")
            return T.union(
              ...T.members(input).map((t) =>
                t._tag === "Tuple"
                  ? t.items.length === 1
                    ? t.items[0]!
                    : T.string
                  : t._tag === "Array"
                    ? T.union(T.string, t.item)
                    : T.unknown,
              ),
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
      const key = `${e.span.start}:${e.span.end}`;
      expressionTypes[key] = T.union(expressionTypes[key] ?? T.never, type);
      return type;
    };
    const narrow = (e: Expression, env: Binding.Flow<T.Type>, truth = true): void => {
      if (e._tag === "Not") {
        narrow(e.value, env, !truth);
        return;
      }
      if (e._tag === "Lookup") {
        const type = infer(e, env, true);
        env.locals.set(
          `@${path(e)}`,
          T.union(
            ...T.members(type).flatMap((t) => {
              if (t._tag === "Boolean") return [T.literal(truth)];
              const falsy =
                t._tag === "Nil" ||
                t._tag === "Missing" ||
                (t._tag === "Literal" && t.value === false);
              return falsy === !truth || t._tag === "Unknown" ? [t] : [];
            }),
          ),
        );
      } else if (e._tag === "Binary") {
        if ((e.operator === "and" && truth) || (e.operator === "or" && !truth)) {
          narrow(e.left, env, truth);
          narrow(e.right, env, truth);
        } else if (e.operator === "==" || e.operator === "!=") {
          const lookup =
            e.left._tag === "Lookup" ? e.left : e.right._tag === "Lookup" ? e.right : undefined;
          const literal =
            e.left._tag === "Literal" ? e.left : e.right._tag === "Literal" ? e.right : undefined;
          if (!lookup || !literal) return;
          const equal = truth === (e.operator === "==");
          const target = literal.value === null ? T.nil : T.literal(literal.value);
          const type = infer(lookup, env, true);
          env.locals.set(
            `@${path(lookup)}`,
            T.union(
              ...T.members(type).flatMap((t) => {
                if (t._tag === "Unknown") return [t];
                if (literal.value === null)
                  return (t._tag === "Nil" || t._tag === "Missing") === equal ? [t] : [];
                if (t._tag === "Literal") return (t.value === literal.value) === equal ? [t] : [];
                if (T.kind(t) === T.kind(target)) return [equal ? target : t];
                return equal ? [] : [t];
              }),
            ),
          );
        }
      }
    };
    const externalType = (name: string): T.Type =>
      contract._tag === "Record"
        ? (contract.fields[name] ?? contract.index ?? T.missing)
        : T.unknown;
    const merge = (types: readonly (T.Type | undefined)[], name: string) =>
      T.union(...types.map((t) => t ?? externalType(name)));
    const body = (
      nodes: readonly Node[],
      env: Binding.Flow<T.Type>,
    ): Binding.Completion<T.Type> => {
      const breaks: Binding.Flow<T.Type>[] = [];
      const continues: Binding.Flow<T.Type>[] = [];
      const absorb = (result: Binding.Completion<T.Type>) => {
        breaks.push(...result.breaks);
        continues.push(...result.continues);
      };
      for (const n of nodes) {
        if (++flowWork > 100_000) {
          unknown("Check traversal limit exceeded", n.span);
          return { normal: env, breaks, continues };
        }
        if (!Object.hasOwn(Binding.tagMetadata, n._tag)) {
          unknown("Opaque custom tag", n.span);
          continue;
        }
        switch (n._tag) {
          case "Text":
            break;
          case "Break":
            breaks.push(Binding.fork(env));
            return { normal: undefined, breaks, continues };
          case "Continue":
            continues.push(Binding.fork(env));
            return { normal: undefined, breaks, continues };
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
          case "Capture": {
            const result = body(n.body, env);
            for (const next of [
              ...(result.normal ? [result.normal] : []),
              ...result.breaks,
              ...result.continues,
            ]) {
              next.values.set(n.name, T.string);
              for (const key of next.locals.keys())
                if (key.startsWith("@")) next.locals.delete(key);
            }
            absorb(result);
            if (!result.normal) return { normal: undefined, breaks, continues };
            break;
          }
          case "If": {
            const otherwise = Binding.fork(env);
            const branches = n.branches.map((b) => {
              infer(b.condition, otherwise, true);
              const next = Binding.fork(otherwise);
              narrow(b.condition, next);
              narrow(b.condition, otherwise, false);
              return body(b.body, next);
            });
            branches.push(body(n.otherwise, otherwise));
            for (const result of branches) absorb(result);
            const normal = branches.flatMap((result) => (result.normal ? [result.normal] : []));
            if (!normal.length) return { normal: undefined, breaks, continues };
            Binding.join(env, normal, merge);
            break;
          }
          case "Case": {
            infer(n.expression, env);
            const branches = n.branches.map((b) => {
              for (const e of b.values) infer(e, env);
              const next = Binding.fork(env);
              return body(b.body, next);
            });
            const otherwise = Binding.fork(env);
            branches.push(body(n.otherwise, otherwise));
            for (const result of branches) absorb(result);
            const normal = branches.flatMap((result) => (result.normal ? [result.normal] : []));
            if (!normal.length) return { normal: undefined, breaks, continues };
            Binding.join(env, normal, merge);
            break;
          }
          case "For":
          case "TableRow": {
            const type = infer(n.collection, env);
            if (n.limit) infer(n.limit, env);
            if (n.offset) infer(n.offset, env);
            if (n._tag === "TableRow" && n.cols) infer(n.cols, env);
            const initial = Binding.fork(env);
            const item = T.union(
              ...T.members(type).map((t) =>
                t._tag === "Array"
                  ? t.item
                  : t._tag === "Tuple"
                    ? T.union(...t.items)
                    : t._tag === "Record"
                      ? T.tuple(T.string, T.union(...Object.values(t.fields), t.index ?? T.never))
                      : t._tag === "Nil" || t._tag === "Missing"
                        ? T.never
                        : t._tag === "Unknown"
                          ? unknown("Unknown loop element type", n.span)
                          : t,
              ),
            );
            initial.locals.set(n.name, item);
            for (const key of initial.locals.keys())
              if (
                key === `@${n.name}` ||
                key.startsWith(`@${n.name}.`) ||
                key.startsWith(`@${n.name}[`) ||
                key === "@forloop" ||
                key.startsWith("@forloop.")
              )
                initial.locals.delete(key);
            initial.locals.set(
              Binding.tagMetadata[n._tag].builtin!,
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
                  : { name: T.string, parentloop: T.missing }),
              }),
            );
            const shape = Binding.loopShape(n);
            const single =
              !shape.repeat && shape.body ? body(n.body, Binding.fork(initial)) : undefined;
            const result = !shape.body
              ? { exits: [initial], converged: true }
              : single
                ? {
                    exits: [
                      ...(single.normal ? [single.normal] : []),
                      ...single.breaks,
                      ...single.continues,
                    ],
                    converged: true,
                  }
                : Binding.fixedPoint(
                    initial,
                    (next) => {
                      const result = body(n.body, next);
                      if (
                        n._tag === "TableRow" &&
                        (result.breaks.length || result.continues.length)
                      )
                        unknown(
                          "Table-row control propagation requires a runtime-specific summary",
                          n.span,
                        );
                      return result;
                    },
                    merge,
                    (a, b) => JSON.stringify(a) === JSON.stringify(b),
                    () => T.unknown,
                  );
            if (!result.converged)
              unknown("Loop type widening exceeded the precision bound", n.span);
            const otherwise =
              n._tag === "For"
                ? shape.empty
                  ? body(n.otherwise, Binding.fork(env))
                  : Binding.completion<T.Type>(undefined)
                : shape.empty
                  ? Binding.completion(Binding.fork(env))
                  : Binding.completion<T.Type>(undefined);
            absorb(otherwise);
            Binding.join(
              env,
              [...result.exits, ...(otherwise.normal ? [otherwise.normal] : [])],
              merge,
            );
            break;
          }
          case "Block": {
            const next = Binding.fork(env);
            next.locals.set("block", T.record({ super: T.string }));
            body(n.body, next);
            unknown("Block inheritance requires project checking", n.span);
            break;
          }
          case "Layout":
            if (n.template) infer(n.template, env);
            for (const value of Object.values(n.args)) infer(value, env);
            body(n.body, env);
            unknown("Layout contract has not been checked", n.span);
            break;
          case "Partial":
            infer(n.template, env);
            for (const e of Object.values(n.args)) infer(e, env);
            if (n.with) infer(n.with.value, env);
            if (n.for) infer(n.for.value, env);
            unknown("Partial contract has not been checked", n.span);
            break;
          default:
            unknown("Opaque custom tag", (n as Node).span);
        }
      }
      return { normal: env, breaks, continues };
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
