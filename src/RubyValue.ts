import type { Value } from "./Value.js";

export type TaggedValue = {
  readonly $liquid: { readonly [key: string]: Value };
};
export const float = (value: number | string): TaggedValue => ({
  $liquid: { type: "float", value: String(value) },
});
export const integer = (value: number | string | bigint): TaggedValue => ({
  $liquid: { type: "integer", value: String(value) },
});
export const decimal = (value: number | string): TaggedValue => ({
  $liquid: { type: "decimal", value: String(value) },
});
export const symbol = (value: string): TaggedValue => ({ $liquid: { type: "symbol", value } });
export const range = (from: Value, to: Value, exclusive = false): TaggedValue => ({
  $liquid: { type: "range", from, to, exclusive },
});
export const hash = (entries: readonly (readonly [Value, Value])[]): TaggedValue => ({
  $liquid: { type: "hash", entries },
});
export const tag = (value: Value | undefined): TaggedValue["$liquid"] | undefined =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  "$liquid" in value &&
  value.$liquid &&
  typeof value.$liquid === "object" &&
  !Array.isArray(value.$liquid)
    ? (value.$liquid as TaggedValue["$liquid"])
    : undefined;
const array = (v: Value | undefined): v is readonly Value[] => Array.isArray(v);
export function numeric(value: Value | undefined): number {
  const t = tag(value);
  if (t && ["integer", "float", "decimal"].includes(String(t.type))) return Number(t.value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(/^\s*[+-]?\d+(?:\.\d+)?/.exec(value)?.[0] ?? 0);
  return 0;
}
export const isNumeric = (v: Value | undefined) =>
  typeof v === "number" || ["integer", "float", "decimal"].includes(String(tag(v)?.type));
export const floating = (v: Value | undefined) =>
  ["float", "decimal"].includes(String(tag(v)?.type)) ||
  (typeof v === "number" && !Number.isInteger(v)) ||
  (typeof v === "string" && /^\s*[+-]?\d+\.\d+\s*$/.test(v));
export function inspect(value: Value | undefined): string {
  if (value == null) return "nil";
  if (typeof value === "string") return JSON.stringify(value).replace(/#\{/g, "\\#{");
  const t = tag(value);
  if (t?.type === "symbol")
    return /^[A-Za-z_]\w*[!?=]?$/.test(String(t.value))
      ? `:${t.value}`
      : `:${JSON.stringify(t.value)}`;
  if (array(value)) return `[${value.map(inspect).join(", ")}]`;
  if (t?.type === "hash")
    return `{${(t.entries as readonly (readonly Value[])[]).map(([k, v]) => `${inspect(k)}=>${inspect(v)}`).join(", ")}}`;
  if (typeof value === "object" && !t)
    return `{${Object.entries(value)
      .map(([k, v]) => `${inspect(k)}=>${inspect(v)}`)
      .join(", ")}}`;
  return toString(value);
}
export function toString(value: Value | undefined): string {
  if (value == null) return "";
  const t = tag(value);
  if (t?.type === "integer" || t?.type === "symbol") return String(t.value);
  if (t?.type === "float" || t?.type === "decimal") {
    const n = Number(t.value);
    const s = String(n);
    return Number.isInteger(n) && !s.includes("e") ? `${Object.is(n, -0) ? "-0" : s}.0` : s;
  }
  if (t?.type === "range")
    return `${toString(t.from)}${t.exclusive ? "..." : ".."}${toString(t.to)}`;
  if (typeof value === "object") return inspect(value);
  return String(value);
}
export const output = (value: Value | undefined): string =>
  array(value) ? value.map(output).join("") : toString(value);
export function lookup(
  value: Value | undefined,
  key: Value | undefined,
): { readonly found: boolean; readonly value?: Value } {
  const t = tag(value);
  if (!t) return { found: false };
  const name = toString(key);
  if (t.type === "hash") {
    const entries = t.entries as readonly (readonly Value[])[];
    const pair = entries.find(([k]) => toString(k) === name);
    return {
      found: true,
      ...(pair ? { value: pair[1]! } : name === "size" ? { value: entries.length } : {}),
    };
  }
  if (t.type === "range") {
    const from = Math.trunc(numeric(t.from)),
      end = Math.trunc(numeric(t.to)) - (t.exclusive ? 1 : 0);
    const size = Math.max(0, end - from + 1);
    return {
      found: true,
      ...(name === "size"
        ? { value: size }
        : name === "first"
          ? { value: from }
          : name === "last"
            ? { value: end }
            : {}),
    };
  }
  return { found: true };
}
export function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (a == null && b == null) return true;
  if (isNumeric(a) && isNumeric(b)) return numeric(a) === numeric(b);
  if (array(a) && array(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (tag(a) || tag(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
export function validate(value: Value): void {
  const t = tag(value);
  if (t) {
    if (["integer", "float", "decimal"].includes(String(t.type))) {
      if (
        typeof t.value !== "string" ||
        t.value.length > 1000 ||
        !/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t.value) ||
        !Number.isFinite(Number(t.value)) ||
        Math.abs(Number(t.value.toLowerCase().split("e")[1] ?? 0)) > 1000 ||
        (t.type === "integer" && !/^[+-]?\d+$/.test(t.value))
      )
        throw new Error("Invalid Ruby number");
    } else if (t.type === "symbol") {
      if (typeof t.value !== "string") throw new Error("Invalid Ruby symbol");
    } else if (t.type === "range") {
      if (!isNumeric(t.from) || !isNumeric(t.to) || typeof t.exclusive !== "boolean")
        throw new Error("Invalid Ruby range");
      if (Math.abs(numeric(t.to) - numeric(t.from)) > 100000)
        throw new Error("Ruby range limit exceeded");
      validate(t.from!);
      validate(t.to!);
    } else if (t.type === "hash") {
      if (!array(t.entries) || !t.entries.every((p) => array(p) && p.length === 2))
        throw new Error("Invalid Ruby hash");
      for (const p of t.entries as readonly (readonly Value[])[]) for (const v of p) validate(v);
    } else throw new Error("Unknown Ruby value tag");
  } else if (value && typeof value === "object") for (const v of Object.values(value)) validate(v);
}
// Finite decimal coefficients avoid binary accumulation error in Ruby arithmetic.
function coefficient(value: Value | undefined): { n: bigint; scale: number } {
  const t = tag(value);
  const source = t && isNumeric(value) ? String(t.value) : String(numeric(value));
  const [mantissa, exponent = "0"] = source.toLowerCase().split("e");
  const scale = (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent);
  let n = BigInt(mantissa!.replace(".", ""));
  if (scale < 0) n *= 10n ** BigInt(-scale);
  return { n, scale: Math.max(0, scale) };
}
function decimalNumber(n: bigint, scale: number): number {
  const sign = n < 0n ? "-" : "",
    digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  return Number(sign + (scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits));
}
export function arithmetic(name: string, a: Value | undefined, b?: Value): Value {
  const x = coefficient(a),
    y = coefficient(b),
    scale = Math.max(x.scale, y.scale);
  const l = x.n * 10n ** BigInt(scale - x.scale),
    r = y.n * 10n ** BigInt(scale - y.scale);
  const f = floating(a) || floating(b);
  if (
    !f &&
    x.scale === 0 &&
    y.scale === 0 &&
    ["plus", "minus", "times", "divided_by", "modulo"].includes(name)
  ) {
    let n: bigint;
    if (name === "plus") n = x.n + y.n;
    else if (name === "minus") n = x.n - y.n;
    else if (name === "times") n = x.n * y.n;
    else {
      const q = x.n / y.n,
        floor = q - (x.n % y.n !== 0n && x.n < 0n !== y.n < 0n ? 1n : 0n);
      n = name === "divided_by" ? floor : x.n - floor * y.n;
    }
    return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(n)
      : integer(n);
  }
  let result: number;
  switch (name) {
    case "plus":
    case "minus": {
      const n = name === "plus" ? l + r : l - r;
      if (
        !f &&
        scale === 0 &&
        (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER))
      )
        return integer(n);
      result = decimalNumber(n, scale);
      break;
    }
    case "times":
      result = decimalNumber(x.n * y.n, x.scale + y.scale);
      break;
    case "divided_by":
      result = numeric(a) / numeric(b);
      if (!f) result = Math.floor(result);
      break;
    case "modulo":
      result = ((numeric(a) % numeric(b)) + numeric(b)) % numeric(b);
      break;
    case "at_least":
      return numeric(a) >= numeric(b) ? (a ?? 0) : (b ?? 0);
    case "at_most":
      return numeric(a) <= numeric(b) ? (a ?? 0) : (b ?? 0);
    default:
      result = 0;
  }
  return f ? float(result) : result;
}
