import type { Effect } from "effect";
import type { Value } from "./Value.js";
export interface Signature {
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly input: "any" | "string" | "number" | "array";
  readonly output: "string" | "number" | "array" | "input" | "unknown";
  readonly argument?: "string" | "number";
}
export interface Filter<E = never, R = never> {
  readonly run: (
    input: Value,
    args: readonly Value[],
    named: Readonly<Record<string, Value>>,
  ) => Effect.Effect<Value, E, R>;
  readonly signature?: Signature;
}
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
