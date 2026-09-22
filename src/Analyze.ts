import { Effect } from "effect";
import type { Document, Expression, Node } from "./Ast.js";
import * as Binding from "./Binding.js";
import { registry as builtins } from "./Builtins.js";
import type { Diagnostic } from "./Diagnostic.js";
import { type BuiltinFilterError, ParseError } from "./Diagnostic.js";
import { embeddedExpression } from "./EmbeddedExpression.js";
import type { Registry } from "./Filter.js";
import type { Span } from "./Source.js";
export interface Declaration {
  readonly id: string;
  readonly name: string;
  readonly kind: "assign" | "capture" | "loop" | "builtin" | "counter" | "filter";
  readonly span: Span;
}
export interface Occurrence {
  readonly id: string;
  readonly path: string;
  readonly expression: Extract<Expression, { _tag: "Lookup" }>;
  readonly span: Span;
  readonly bindings: readonly string[];
  readonly external: boolean;
  readonly derivedPaths: readonly string[];
  readonly control: readonly string[];
}
export interface Dependency {
  readonly mode: "render" | "include";
  readonly target: string | undefined;
  readonly span: Span;
  readonly args: Readonly<Record<string, Expression>>;
  readonly iteration?: { readonly name: string; readonly collection: Expression };
}
export interface Analysis {
  readonly occurrences: readonly Occurrence[];
  readonly bindings: readonly Declaration[];
  readonly externalRoots: readonly string[];
  readonly externalPaths: readonly string[];
  readonly derivedInputPaths: readonly string[];
  readonly dependencies: readonly Dependency[];
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: "complete" | "partial";
  readonly coverageReasons: readonly string[];
}
interface Slot {
  ids: string[];
  external: boolean;
  origins: string[];
}
export function path(e: Expression): string {
  switch (e._tag) {
    case "SelfLookup":
      return e.segments.map((segment) => `[${path(segment)}]`).join("");
    case "Lookup":
      return (
        e.root +
        e.segments
          .map((s) =>
            s._tag === "Literal"
              ? typeof s.value === "string" && /^[\w-]+$/.test(s.value)
                ? `.${s.value}`
                : `[${JSON.stringify(s.value)}]`
              : `[${path(s)}]`,
          )
          .join("")
      );
    case "Literal":
      return JSON.stringify(e.value);
    case "Special":
      return e.value;
    case "Range":
      return `(${path(e.from)}..${path(e.to)})`;
    case "Not":
      return `not ${path(e.value)}`;
    case "Binary":
      return `${path(e.left)} ${e.operator} ${path(e.right)}`;
    case "Filter":
      return `${path(e.input)} | ${e.name}`;
  }
}
const unique = <T>(values: readonly T[]) => [...new Set(values)];
export const analyze = <E, R>(
  document: Document,
  registry: Registry<E | BuiltinFilterError, R> = builtins,
): Effect.Effect<Analysis> =>
  Effect.sync((): Analysis => {
    const occurrences: Occurrence[] = [];
    const bindings: Declaration[] = [];
    const dependencies: Dependency[] = [];
    const diagnostics: Diagnostic[] = [];
    const reasons: string[] = [];
    let embeddedDepth = 0;
    const merge = (slots: readonly (Slot | undefined)[]): Slot => ({
      ids: unique(slots.flatMap((s) => s?.ids ?? [])),
      external: slots.some((s) => !s || s.external),
      origins: unique(slots.flatMap((s) => s?.origins ?? [])),
    });
    const declare = (
      name: string,
      kind: Declaration["kind"],
      span: Span,
      origins: string[] = [],
    ): Slot => {
      const id = `${document.source.id}:binding:${bindings.length}`;
      bindings.push({ id, name, kind, span });
      return { ids: [id], external: false, origins };
    };
    const provenance = (e: Expression, env: Binding.Flow<Slot>): string[] => {
      if (e._tag !== "Lookup") return [];
      const slot = Binding.read(env, e.root);
      const suffix = path(e).slice(e.root.length);
      return unique([
        ...(slot?.origins ?? []).map((p) => p + suffix),
        ...(!slot || slot.external ? [path(e)] : []),
      ]);
    };
    const expression = (
      e: Expression,
      env: Binding.Flow<Slot>,
      control: readonly string[],
    ): void => {
      switch (e._tag) {
        case "SelfLookup": {
          const [first, ...rest] = e.segments;
          if (first?._tag === "Literal" && typeof first.value === "string") {
            expression(
              { _tag: "Lookup", root: first.value, segments: rest, span: e.span },
              env,
              control,
            );
          } else {
            for (const segment of e.segments) expression(segment, env, control);
            reasons.push(`Dynamic context-root lookup at ${e.span.start}`);
          }
          break;
        }
        case "Lookup": {
          const slot = Binding.read(env, e.root);
          occurrences.push({
            id: `${document.source.id}:read:${occurrences.length}`,
            path: path(e),
            expression: e,
            span: e.span,
            bindings: slot?.ids ?? [],
            external: !slot || slot.external,
            derivedPaths: slot ? provenance(e, env) : [],
            control,
          });
          for (const s of e.segments) expression(s, env, control);
          break;
        }
        case "Filter": {
          expression(e.input, env, control);
          for (const arg of [...e.args, ...Object.values(e.named)]) expression(arg, env, control);
          const filter = registry.filters.get(e.name);
          if (filter && "expression" in filter) {
            const alias = e.args[0],
              predicate = e.args[1];
            if (
              embeddedDepth >= 32 ||
              alias?._tag !== "Literal" ||
              typeof alias.value !== "string" ||
              predicate?._tag !== "Literal" ||
              typeof predicate.value !== "string"
            ) {
              reasons.push(`Dynamic or deeply nested expression filter at ${e.span.start}`);
            } else {
              const next = Binding.fork(env);
              next.locals.set(
                alias.value,
                declare(
                  alias.value,
                  "filter",
                  alias.span,
                  provenance(e.input, env).map((p) => `${p}[*]`),
                ),
              );
              embeddedDepth++;
              try {
                expression(
                  embeddedExpression(predicate.value, predicate.span, document.groupedExpressions),
                  next,
                  [...control, `filter:${e.span.start}`],
                );
              } catch (error) {
                if (!(error instanceof ParseError)) throw error;
                reasons.push(`Invalid expression filter at ${e.span.start}: ${error.message}`);
              } finally {
                embeddedDepth--;
              }
              reasons.push(
                `Embedded expression locations use the containing argument span at ${predicate.span.start}`,
              );
            }
          }
          break;
        }
        case "Binary":
          expression(e.left, env, control);
          expression(e.right, env, control);
          break;
        case "Range":
          expression(e.from, env, control);
          expression(e.to, env, control);
          break;
        case "Not":
          expression(e.value, env, control);
          break;
      }
    };
    const body = (
      nodes: readonly Node[],
      env: Binding.Flow<Slot>,
      control: readonly string[],
    ): void => {
      for (const n of nodes)
        switch (n._tag) {
          case "Text":
            break;
          case "Output":
            expression(n.expression, env, control);
            break;
          case "Counter": {
            // A numeric caller input seeds the register even if an assignment shadows it.
            expression(
              { _tag: "Lookup", root: n.name, segments: [], span: n.nameSpan },
              Binding.make(),
              control,
            );
            const slot = declare(n.name, "counter", n.span);
            if (!env.values.has(n.name)) env.values.set(n.name, slot);
            reasons.push(`Counter seed dependencies are conservative at ${n.span.start}`);
            break;
          }
          case "Cycle":
            if (n.group) expression(n.group, env, control);
            for (const value of n.values)
              expression(value, env, [...control, `cycle:${n.span.start}`]);
            break;
          case "Assign":
            expression(n.expression, env, control);
            env.values.set(
              n.name,
              declare(n.name, "assign", n.span, provenance(n.expression, env)),
            );
            break;
          case "Capture":
            body(n.body, env, control);
            env.values.set(n.name, declare(n.name, "capture", n.span));
            break;
          case "If": {
            const branches = n.branches.map((b, i) => {
              expression(b.condition, env, control);
              const next = Binding.fork(env);
              body(b.body, next, [...control, `if:${n.span.start}:${i}`]);
              return next;
            });
            const otherwise = Binding.fork(env);
            body(n.otherwise, otherwise, [...control, `else:${n.span.start}`]);
            Binding.join(env, [...branches, otherwise], merge);
            break;
          }
          case "Case": {
            expression(n.expression, env, control);
            const branches = n.branches.map((b, i) => {
              for (const e of b.values) expression(e, env, control);
              const next = Binding.fork(env);
              body(b.body, next, [...control, `when:${n.span.start}:${i}`]);
              return next;
            });
            const otherwise = Binding.fork(env);
            body(n.otherwise, otherwise, control);
            Binding.join(env, [...branches, otherwise], merge);
            break;
          }
          case "For":
          case "TableRow": {
            expression(n.collection, env, control);
            if (n.limit) expression(n.limit, env, control);
            if (n.offset) expression(n.offset, env, control);
            if (n._tag === "TableRow" && n.cols) expression(n.cols, env, control);
            const next = Binding.fork(env);
            next.locals.set(
              n.name,
              declare(
                n.name,
                "loop",
                n.span,
                provenance(n.collection, env).map((p) => `${p}[*]`),
              ),
            );
            const loopName = n._tag === "TableRow" ? "tablerowloop" : "forloop";
            next.locals.set(loopName, declare(loopName, "builtin", n.span));
            body(n.body, next, [...control, `for:${n.span.start}`]);
            if ([...next.values].some(([name, slot]) => slot !== env.values.get(name)))
              reasons.push(`Loop-carried assignment provenance is conservative at ${n.span.start}`);
            const otherwise = Binding.fork(env);
            if (n._tag === "For") body(n.otherwise, otherwise, control);
            Binding.join(env, [next, otherwise], merge);
            break;
          }
          case "Block": {
            const next = Binding.fork(env);
            next.locals.set("block", declare("block", "builtin", n.span));
            body(n.body, next, [...control, `block:${n.name}`]);
            reasons.push(`Block inheritance analysis is partial at ${n.span.start}`);
            break;
          }
          case "Layout": {
            if (n.template) expression(n.template, env, control);
            for (const value of Object.values(n.args)) expression(value, env, control);
            body(n.body, env, [...control, `layout:${n.span.start}`]);
            reasons.push(`Layout dependency analysis is partial at ${n.span.start}`);
            break;
          }
          case "Partial": {
            expression(n.template, env, control);
            for (const e of Object.values(n.args)) expression(e, env, control);
            if (n.with) expression(n.with.value, env, control);
            if (n.for) expression(n.for.value, env, control);
            const target =
              n.template._tag === "Literal" &&
              typeof n.template.value === "string" &&
              !n.template.value.includes("{{")
                ? n.template.value
                : undefined;
            const args: Record<string, Expression> = Object.assign(Object.create(null), n.args);
            if (n.with && (n.with.alias ?? target) !== undefined)
              args[n.with.alias ?? target!] = n.with.value;
            const iteration = n.for
              ? { name: n.for.alias ?? "undefined", collection: n.for.value }
              : undefined;
            if (iteration) {
              args[iteration.name] = iteration.collection;
              if (iteration.collection._tag !== "Lookup")
                reasons.push(`Render collection provenance is conservative at ${n.span.start}`);
            }
            dependencies.push({
              mode: n.mode,
              target,
              span: n.span,
              args,
              ...(iteration ? { iteration } : {}),
            });
            reasons.push(`Unanalyzed ${n.mode} dependency at ${n.span.start}`);
            if (n.mode === "include") {
              for (const [name, slot] of env.values)
                env.values.set(name, { ...slot, external: true, origins: [] });
            }
            break;
          }
          case "Break":
          case "Continue":
            reasons.push(`Loop control flow is conservative at ${n.span.start}`);
            return;
        }
    };
    body(document.body, Binding.make(), []);
    const external = occurrences.filter((o) => o.external);
    return {
      occurrences,
      bindings,
      externalRoots: unique(external.map((o) => o.expression.root)),
      externalPaths: unique(external.map((o) => o.path)),
      derivedInputPaths: unique(occurrences.flatMap((o) => o.derivedPaths)),
      dependencies,
      diagnostics,
      coverage: reasons.length ? "partial" : "complete",
      coverageReasons: unique(reasons),
    };
  }).pipe(Effect.withSpan("liquid.analyze"));
