import { ParseError } from "./Diagnostic.js";
import { readExpression } from "./ExpressionParser.js";
import { make } from "./Source.js";

/** Decode static dot and bracket keys; dynamic keys require an evaluation context. */
export function propertyKeys(path: string): readonly (string | number)[] | undefined {
  if (!path) return [""];
  try {
    const parsed = readExpression(make(`value${path.startsWith("[") ? "" : "."}${path}`));
    if (parsed._tag !== "Lookup" || parsed.root !== "value") return undefined;
    const result: (string | number)[] = [];
    for (const segment of parsed.segments) {
      if (
        segment._tag !== "Literal" ||
        (typeof segment.value !== "string" && typeof segment.value !== "number")
      )
        return undefined;
      result.push(segment.value);
    }
    return result;
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}
