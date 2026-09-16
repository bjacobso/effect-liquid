import { Effect } from "effect";
import { RenderError } from "./Diagnostic.js";
import type { Span } from "./Source.js";
export type Value =
  | null
  | boolean
  | number
  | string
  | readonly Value[]
  | { readonly [key: string]: Value };
export const forbidden = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);
export const isArray = (value: Value | undefined): value is readonly Value[] =>
  Array.isArray(value);
export const truthy = (value: Value | undefined) =>
  value !== undefined && value !== null && value !== false;
export const stringify = (value: Value | undefined): string =>
  value == null
    ? ""
    : isArray(value)
      ? value.map(stringify).join("")
      : typeof value === "object"
        ? "[object Object]"
        : String(value);
export const empty = (value: Value | undefined): boolean =>
  value === "" ||
  (isArray(value) && value.length === 0) ||
  (value !== null &&
    typeof value === "object" &&
    !isArray(value) &&
    Object.keys(value).length === 0);
export const blank = (value: Value | undefined) =>
  value == null ||
  value === false ||
  empty(value) ||
  (typeof value === "string" && value.trim() === "");
export function lookup(value: Value | undefined, key: Value | undefined): Value | undefined {
  if (value == null || key == null) return undefined;
  const name = stringify(key);
  if (forbidden(name)) return undefined;
  if (isArray(value) || typeof value === "string") {
    if (name === "size" || name === "length") return value.length;
    if (name === "first" && isArray(value)) return value[0];
    if (name === "last" && isArray(value)) return value[value.length - 1];
    if (typeof key === "number" || /^(?:0|[1-9]\d*)$/.test(name)) {
      let index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      if (index < 0 && isArray(value) && typeof key === "number") index += value.length;
      return value[index];
    }
    return undefined;
  }
  if (typeof value === "object") {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (property) return property.value as Value | undefined;
    if (name === "size") return Object.keys(value).length;
  }
  return undefined;
}
export function normalize(
  input: unknown,
  at: Span,
  maxNodes = 100_000,
): Effect.Effect<Value, RenderError> {
  return Effect.try({
    try: () => {
      let count = 0;
      let characters = 0;
      const ancestors = new Set<object>();
      const walk = (v: unknown, depth: number): Value => {
        if (++count > maxNodes || depth > 128)
          throw new RenderError({
            code: "ResourceLimitExceeded",
            message: "Context size/depth limit exceeded",
            span: at,
          });
        if (v === undefined || v === null) return null;
        if (typeof v === "string") {
          characters += v.length;
          if (characters > 10_000_000)
            throw new RenderError({
              code: "ResourceLimitExceeded",
              message: "Context string size limit exceeded",
              span: at,
            });
          return v;
        }
        if (typeof v === "boolean") return v;
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "object" || v === null)
          throw new RenderError({
            code: "InvalidContext",
            message: "Unsupported context value",
            span: at,
          });
        if (ancestors.has(v))
          throw new RenderError({ code: "InvalidContext", message: "Cyclic context", span: at });
        if (
          !Array.isArray(v) &&
          Object.getPrototypeOf(v) !== Object.prototype &&
          Object.getPrototypeOf(v) !== null
        )
          throw new RenderError({
            code: "InvalidContext",
            message: "Expected plain record",
            span: at,
          });
        ancestors.add(v);
        let result: Value;
        if (Array.isArray(v)) {
          if (v.length > maxNodes - count)
            throw new RenderError({
              code: "ResourceLimitExceeded",
              message: "Array size limit exceeded",
              span: at,
            });
          result = Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (d && !("value" in d))
              throw new RenderError({
                code: "InvalidContext",
                message: "Accessors are unsupported",
                span: at,
              });
            return walk(d?.value, depth + 1);
          });
        } else {
          const out: Record<string, Value> = Object.create(null);
          for (const key of Object.keys(v)) {
            if (forbidden(key)) continue;
            const d = Object.getOwnPropertyDescriptor(v, key)!;
            if (!("value" in d))
              throw new RenderError({
                code: "InvalidContext",
                message: "Accessors are unsupported",
                span: at,
              });
            out[key] = walk(d.value, depth + 1);
          }
          result = out;
        }
        ancestors.delete(v);
        return result;
      };
      return walk(input, 0);
    },
    catch: (error) => {
      if (error instanceof RenderError) return error;
      throw error;
    },
  });
}
