export type Type =
  | { readonly _tag: "Unknown" | "Never" | "Nil" | "Missing" | "String" | "Number" | "Boolean" }
  | { readonly _tag: "Literal"; readonly value: string | number | boolean }
  | { readonly _tag: "Array"; readonly item: Type }
  | { readonly _tag: "Tuple"; readonly items: readonly Type[] }
  | {
      readonly _tag: "Record";
      readonly fields: Readonly<Record<string, Type>>;
      readonly index?: Type;
    }
  | { readonly _tag: "Union"; readonly members: readonly Type[] };
export const unknown: Type = { _tag: "Unknown" };
export const never: Type = { _tag: "Never" };
export const nil: Type = { _tag: "Nil" };
export const missing: Type = { _tag: "Missing" };
export const string: Type = { _tag: "String" };
export const number: Type = { _tag: "Number" };
export const boolean: Type = { _tag: "Boolean" };
export const literal = (value: string | number | boolean): Type => ({ _tag: "Literal", value });
export const array = (item: Type): Type => ({ _tag: "Array", item });
export const tuple = (...items: Type[]): Type => ({ _tag: "Tuple", items });
export const record = (fields: Readonly<Record<string, Type>>, index?: Type): Type => ({
  _tag: "Record",
  fields,
  ...(index ? { index } : {}),
});
export function union(...types: Type[]): Type {
  const members = [
    ...new Map(
      types
        .flatMap((t) => (t._tag === "Union" ? t.members : [t]))
        .filter((t) => t._tag !== "Never")
        .map((t) => [JSON.stringify(t), t]),
    ).values(),
  ];
  return members.length === 0
    ? never
    : members.length === 1
      ? members[0]!
      : members.length > 32
        ? unknown
        : { _tag: "Union", members };
}
export const optional = (type: Type): Type => union(type, missing);
export const members = (type: Type): readonly Type[] =>
  type._tag === "Union" ? type.members : [type];
export const present = (type: Type): Type =>
  union(
    ...members(type).filter(
      (t) =>
        t._tag !== "Nil" && t._tag !== "Missing" && !(t._tag === "Literal" && t.value === false),
    ),
  );
export const kind = (type: Type): string =>
  type._tag === "Literal" ? typeof type.value : type._tag.toLowerCase();
/** Conservative structural assignment: Unknown never proves compatibility. */
export function assignable(actual: Type, expected: Type, depth = 0): boolean {
  if (depth > 64 || actual._tag === "Unknown" || expected._tag === "Unknown") return false;
  if (actual._tag === "Never") return true;
  if (actual._tag === "Union")
    return actual.members.every((a) => assignable(a, expected, depth + 1));
  if (expected._tag === "Union")
    return expected.members.some((e) => assignable(actual, e, depth + 1));
  if (expected._tag === "Record" && actual._tag === "Record")
    return Object.entries(expected.fields).every(([key, value]) =>
      assignable(actual.fields[key] ?? missing, value, depth + 1),
    );
  if (expected._tag === "Array" && actual._tag === "Array")
    return assignable(actual.item, expected.item, depth + 1);
  if (expected._tag === "Array" && actual._tag === "Tuple")
    return actual.items.every((a) => assignable(a, expected.item, depth + 1));
  if (expected._tag === "Tuple" && actual._tag === "Tuple")
    return (
      expected.items.length === actual.items.length &&
      actual.items.every((a, i) => assignable(a, expected.items[i]!, depth + 1))
    );
  if (expected._tag === "Literal")
    return actual._tag === "Literal" && actual.value === expected.value;
  return kind(actual) === kind(expected);
}
export function isType(value: unknown, depth = 0): value is Type {
  if (depth > 64 || !value || typeof value !== "object" || !("_tag" in value)) return false;
  const v = value as Record<string, unknown>;
  switch (v._tag) {
    case "Unknown":
    case "Never":
    case "Nil":
    case "Missing":
    case "String":
    case "Number":
    case "Boolean":
      return true;
    case "Literal":
      return (
        typeof v.value === "string" ||
        typeof v.value === "boolean" ||
        (typeof v.value === "number" && Number.isFinite(v.value))
      );
    case "Array":
      return isType(v.item, depth + 1);
    case "Tuple":
      return Array.isArray(v.items) && v.items.every((t) => isType(t, depth + 1));
    case "Union":
      return (
        Array.isArray(v.members) &&
        v.members.length <= 32 &&
        v.members.every((t) => isType(t, depth + 1))
      );
    case "Record":
      return (
        !!v.fields &&
        typeof v.fields === "object" &&
        !Array.isArray(v.fields) &&
        Object.values(v.fields).every((t) => isType(t, depth + 1)) &&
        (v.index === undefined || isType(v.index, depth + 1))
      );
    default:
      return false;
  }
}
