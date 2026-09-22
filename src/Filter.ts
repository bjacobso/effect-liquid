import type { Effect } from "effect";
import type { Value } from "./Value.js";
export interface Signature {
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly input: "any" | "string" | "number" | "array";
  readonly output: "string" | "number" | "array" | "input" | "unknown";
  readonly argument?: "string" | "number";
  readonly positionalArguments?: readonly ("string" | "number" | "boolean" | "any")[];
}
export interface FilterCallContext {
  readonly missingArguments: readonly boolean[];
  readonly specialArguments: readonly ("empty" | "blank" | undefined)[];
  readonly jekyllWhere: boolean;
}
export interface NativeFilter<E = never, R = never> {
  readonly run: (
    input: Value,
    args: readonly Value[],
    named: Readonly<Record<string, Value>>,
    context?: FilterCallContext,
  ) => Effect.Effect<Value | undefined, E, R>;
  readonly signature?: Signature;
}
export interface ExpressionFilter {
  readonly expression: "where" | "reject" | "find" | "find_index" | "has" | "group_by";
  readonly signature: Signature;
}
export type Filter<E = never, R = never> = NativeFilter<E, R> | ExpressionFilter;
export interface Registry<E = never, R = never> {
  readonly filters: ReadonlyMap<string, Filter<E, R>>;
}
export const empty: Registry = { filters: new Map() };
export function add<E, R, E2, R2>(
  registry: Registry<E, R>,
  name: string,
  filter: Filter<E2, R2>,
): Registry<E | E2, R | R2> {
  const filters = new Map<string, Filter<E | E2, R | R2>>(registry.filters);
  filters.set(name, filter);
  return { filters };
}
