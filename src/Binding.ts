/** Shared environment boundaries: assignments target the template frame; loop names shadow it. */
export interface Flow<T> {
  readonly values: Map<string, T>;
  readonly locals: Map<string, T>;
}
export const make = <T>(): Flow<T> => ({ values: new Map(), locals: new Map() });
export const fork = <T>(flow: Flow<T>): Flow<T> => ({
  values: new Map(flow.values),
  locals: new Map(flow.locals),
});
export const read = <T>(flow: Flow<T>, name: string): T | undefined =>
  flow.locals.get(name) ?? flow.values.get(name);
export function join<T>(
  target: Flow<T>,
  branches: readonly Flow<T>[],
  merge: (values: readonly (T | undefined)[]) => T,
): void {
  const names = new Set(branches.flatMap((b) => [...b.values.keys()]));
  for (const name of names) {
    const value = merge(branches.map((b) => b.values.get(name)));
    if (value !== target.values.get(name)) {
      for (const key of target.locals.keys())
        if (key === `@${name}` || key.startsWith(`@${name}.`) || key.startsWith(`@${name}[`))
          target.locals.delete(key);
    }
    target.values.set(name, value);
  }
}
