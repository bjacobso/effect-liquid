import { Effect, Schema as S, type SchemaAST } from "effect";
import * as T from "./Type.js";
export interface Projection {
  readonly type: T.Type;
  readonly coverage: "complete" | "partial";
  readonly reasons: readonly string[];
}
/** Projects decoded shapes. Refinement predicates and transformation functions are never run. */
export const fromSchema = <A, I, R>(schema: S.Schema<A, I, R>): Effect.Effect<Projection> =>
  Effect.sync(() => {
    const reasons = new Set<string>();
    const visiting = new Set<SchemaAST.AST>();
    const unknown = (reason: string): T.Type => {
      reasons.add(reason);
      return T.unknown;
    };
    const visit = (ast: SchemaAST.AST, depth: number): T.Type => {
      if (depth > 64 || visiting.has(ast))
        return unknown("Recursive schema requires a bounded explicit contract");
      visiting.add(ast);
      let type: T.Type;
      switch (ast._tag) {
        case "StringKeyword":
          type = T.string;
          break;
        case "NumberKeyword":
          type = T.number;
          break;
        case "BooleanKeyword":
          type = T.boolean;
          break;
        case "Literal":
          type =
            ast.literal === null
              ? T.nil
              : typeof ast.literal === "bigint"
                ? unknown("BigInt is not a Liquid value")
                : T.literal(ast.literal);
          break;
        case "UndefinedKeyword":
        case "VoidKeyword":
          type = T.missing;
          break;
        case "NeverKeyword":
          type = T.never;
          break;
        case "Union":
          type = T.union(...ast.types.map((t) => visit(t, depth + 1)));
          break;
        case "TupleType": {
          if (ast.elements.length === 0 && ast.rest.length === 1)
            type = T.array(visit(ast.rest[0]!.type, depth + 1));
          else if (ast.rest.length) type = unknown("Mixed variadic tuples are unsupported");
          else
            type = T.tuple(
              ...ast.elements.map((e) =>
                e.isOptional ? T.optional(visit(e.type, depth + 1)) : visit(e.type, depth + 1),
              ),
            );
          break;
        }
        case "TypeLiteral": {
          const fields: Record<string, T.Type> = Object.create(null);
          for (const p of ast.propertySignatures) {
            if (typeof p.name === "symbol") {
              unknown("Symbol keys are unsupported");
              continue;
            }
            const field = visit(p.type, depth + 1);
            fields[String(p.name)] = p.isOptional ? T.optional(field) : field;
          }
          const index = ast.indexSignatures.length
            ? T.union(...ast.indexSignatures.map((i) => visit(i.type, depth + 1)))
            : undefined;
          type = T.record(fields, index);
          break;
        }
        case "Transformation":
          type = visit(ast.to, depth + 1);
          break;
        case "Refinement":
          type = visit(ast.from, depth + 1);
          break;
        case "Suspend":
          type = visit(ast.f(), depth + 1);
          break;
        default:
          type = unknown(`Unsupported schema node: ${ast._tag}`);
      }
      visiting.delete(ast);
      return type;
    };
    const type = visit(schema.ast, 0);
    return {
      type,
      coverage: reasons.size ? ("partial" as const) : ("complete" as const),
      reasons: [...reasons],
    };
  });
export const decode = <A, I, R>(schema: S.Schema<A, I, R>, input: unknown) =>
  S.decodeUnknown(schema)(input);
