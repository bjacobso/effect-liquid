import { Effect } from "effect";
import { analyze } from "./Analyze.js";
import type { Document } from "./Ast.js";
import { registry as builtins } from "./Builtins.js";
import { type CheckOptions, check } from "./Check.js";
import type { BuiltinFilterError, Diagnostic, LoadError, ParseError } from "./Diagnostic.js";
import type { Registry } from "./Filter.js";
import { parse } from "./Parser.js";
import { TemplateLoader } from "./TemplateLoader.js";
import * as T from "./Type.js";
export interface ProjectCheckOptions extends CheckOptions {
  readonly contracts?: Readonly<Record<string, T.Type>>;
  readonly globals?: Readonly<Record<string, T.Type>>;
  readonly maxDocuments?: number;
  readonly maxDepth?: number;
}
export interface ProjectCheckResult {
  readonly passed: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: "complete" | "partial";
  readonly coverageReasons: readonly string[];
}
export const checkProject = <E = never, R = never>(
  document: Document,
  contract: T.Type,
  options: ProjectCheckOptions = {},
  registry: Registry<E | BuiltinFilterError, R> = builtins,
): Effect.Effect<ProjectCheckResult, LoadError | ParseError, TemplateLoader> =>
  Effect.gen(function* () {
    const loader = yield* TemplateLoader;
    const diagnostics: Diagnostic[] = [];
    const reasons = new Set<string>();
    let count = 0;
    const incomplete = (message: string, doc: Document) => {
      reasons.add(message);
      diagnostics.push({
        code: "UnknownCoverage",
        severity: options.mode === "compatibility" ? "warning" : "error",
        message,
        span: { sourceId: doc.source.id, start: 0, end: 0 },
      });
    };
    const visit = (
      doc: Document,
      context: T.Type,
      ancestors: readonly string[],
    ): Effect.Effect<void, LoadError | ParseError, TemplateLoader> =>
      Effect.gen(function* () {
        yield* Effect.yieldNow();
        const result = yield* check(doc, context, options, registry);
        const analysis = yield* analyze(doc);
        diagnostics.push(
          ...result.diagnostics.filter(
            (d) => d.message !== "Partial contract has not been checked",
          ),
        );
        for (const reason of result.coverageReasons)
          if (reason !== "Partial contract has not been checked") reasons.add(reason);
        for (const dep of analysis.dependencies) {
          if (!dep.target) {
            incomplete("Dynamic partial contract cannot be resolved", doc);
            continue;
          }
          if (
            ++count > (options.maxDocuments ?? 128) ||
            ancestors.length >= (options.maxDepth ?? 32)
          ) {
            incomplete("Project check limit exceeded", doc);
            continue;
          }
          const source = yield* loader.load(dep.target, doc.source.id, dep.mode);
          if (ancestors.includes(source.id)) {
            incomplete(`Cyclic partial contract: ${source.id}`, doc);
            continue;
          }
          const child = yield* parse(source);
          if (dep.mode === "include") {
            incomplete("Shared include contract requires a flow summary", doc);
            continue;
          }
          const fields: Record<string, T.Type> = Object.assign(
            Object.create(null),
            options.globals,
          );
          for (const [name, arg] of Object.entries(dep.args)) {
            const type = result.expressionTypes[`${arg.span.start}:${arg.span.end}`] ?? T.unknown;
            fields[name] =
              dep.iteration?.name === name
                ? T.union(
                    ...T.members(type).map((member) =>
                      member._tag === "Array"
                        ? member.item
                        : member._tag === "Tuple"
                          ? T.union(...member.items)
                          : member._tag === "String"
                            ? T.string
                            : T.unknown,
                    ),
                  )
                : type;
          }
          if (dep.iteration)
            fields.forloop = T.record({
              index: T.number,
              index0: T.number,
              rindex: T.number,
              rindex0: T.number,
              first: T.boolean,
              last: T.boolean,
              length: T.number,
            });
          const actual = T.record(fields);
          const expected =
            options.contracts?.[source.id] ?? options.contracts?.[dep.target] ?? actual;
          if (!T.assignable(actual, expected))
            diagnostics.push({
              code: "PartialArgument",
              severity: "error",
              message: `Arguments do not satisfy the contract for ${source.id}`,
              related: [
                { message: "Callee contract", span: { sourceId: source.id, start: 0, end: 0 } },
              ],
              span: dep.span,
            });
          yield* visit(child, expected, [...ancestors, source.id]);
        }
      });
    yield* visit(document, contract, [document.source.id]);
    return {
      passed: !diagnostics.some((d) => d.severity === "error"),
      diagnostics,
      coverage: reasons.size ? ("partial" as const) : ("complete" as const),
      coverageReasons: [...reasons],
    };
  });
