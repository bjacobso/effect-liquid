import { Effect } from "effect";
import { type Analysis, analyze, type Dependency, path } from "./Analyze.js";
import type { Document } from "./Ast.js";
import { registry as builtins } from "./Builtins.js";
import type { BuiltinFilterError, Diagnostic, LoadError, ParseError } from "./Diagnostic.js";
import type { Registry } from "./Filter.js";
import { parse } from "./Parser.js";
import { TemplateLoader } from "./TemplateLoader.js";
export interface ProjectAnalysis {
  readonly entry: Analysis;
  readonly documents: readonly { readonly id: string; readonly analysis: Analysis }[];
  readonly externalPaths: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: "complete" | "partial";
  readonly coverageReasons: readonly string[];
}
export interface ProjectOptions {
  readonly maxDepth?: number;
  readonly maxDocuments?: number;
  readonly globals?: readonly string[];
}
/** A bounded dependency traversal. Dynamic calls and shared-state include analysis remain explicit gaps. */
export const analyzeProject = <E = never, R = never>(
  document: Document,
  options: ProjectOptions = {},
  registry: Registry<E | BuiltinFilterError, R> = builtins,
): Effect.Effect<ProjectAnalysis, LoadError | ParseError, TemplateLoader> =>
  Effect.gen(function* () {
    const loader = yield* TemplateLoader;
    const documents: { id: string; analysis: Analysis }[] = [];
    const diagnostics: Diagnostic[] = [];
    const reasons = new Set<string>();
    const externalPaths = new Set<string>();
    let visited = 0;
    const entry = yield* analyze(document, registry);
    const visit = (
      doc: Document,
      analysis: Analysis,
      ancestors: readonly string[],
      resolve: (p: string) => readonly string[],
    ): Effect.Effect<void, LoadError | ParseError, TemplateLoader> =>
      Effect.gen(function* () {
        yield* Effect.yieldNow();
        documents.push({ id: doc.source.id, analysis });
        for (const reason of analysis.coverageReasons)
          if (!reason.startsWith("Unanalyzed ")) reasons.add(reason);
        for (const p of [...analysis.externalPaths, ...analysis.derivedInputPaths])
          for (const resolved of resolve(p)) externalPaths.add(resolved);
        for (const dep of analysis.dependencies) {
          if (dep.target === undefined) {
            reasons.add(`Dynamic dependency in ${doc.source.id}`);
            continue;
          }
          if (
            ancestors.length >= (options.maxDepth ?? 32) ||
            ++visited > (options.maxDocuments ?? 128)
          ) {
            reasons.add("Project traversal limit exceeded");
            continue;
          }
          const source = yield* loader.load(dep.target, doc.source.id, dep.mode);
          if (ancestors.includes(source.id)) {
            reasons.add(`Cyclic dependency: ${source.id}`);
            continue;
          }
          const child = yield* parse(source, {
            ...doc.whitespace,
            groupedExpressions: doc.groupedExpressions ?? false,
          });
          const childAnalysis = yield* analyze(child, registry);
          const childResolve = (p: string): readonly string[] => {
            const root = /^[^.[]+/.exec(p)?.[0] ?? p;
            const suffix = p.slice(root.length);
            if (dep.iteration && root === "forloop") return [];
            const argument = Object.getOwnPropertyDescriptor(dep.args, root)?.value as
              | Dependency["args"][string]
              | undefined;
            if (argument) {
              if (argument._tag === "Lookup") {
                const occurrence = analysis.occurrences.find(
                  (o) => o.span.start === argument.span.start && o.span.end === argument.span.end,
                );
                const origins = occurrence?.external
                  ? [path(argument)]
                  : (occurrence?.derivedPaths ?? []);
                return origins.flatMap((origin) =>
                  resolve(origin + (dep.iteration?.name === root ? "[*]" : "") + suffix),
                );
              }
              return [];
            }
            if (options.globals?.includes(root)) return [p];
            if (dep.mode === "include") {
              reasons.add(`Shared include scope requires a flow summary: ${source.id}`);
              return resolve(p);
            }
            diagnostics.push({
              code: "MissingPartialArgument",
              severity: "error",
              message: `'${root}' is not supplied to ${source.id}`,
              span: dep.span,
            });
            return [];
          };
          if (dep.mode === "include")
            reasons.add(`Shared include scope requires a flow summary: ${source.id}`);
          yield* visit(child, childAnalysis, [...ancestors, source.id], childResolve);
        }
      });
    yield* visit(document, entry, [document.source.id], (p) => [p]);
    return {
      entry,
      documents,
      externalPaths: [...externalPaths],
      diagnostics,
      coverage: reasons.size ? ("partial" as const) : ("complete" as const),
      coverageReasons: [...reasons],
    };
  }).pipe(Effect.withSpan("liquid.analyzeProject"));
