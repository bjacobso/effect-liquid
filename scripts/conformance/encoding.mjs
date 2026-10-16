// Lossy projection for JavaScript oracles until the Ruby value adapter is enabled.
export function jsonProjection(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(jsonProjection);
  if (Object.keys(value).length === 1 && value.$liquid) {
    const tag = value.$liquid;
    switch (tag.type) {
      case "integer":
      case "float":
      case "decimal":
        return Number(tag.value);
      case "symbol":
        return tag.value;
      case "range": {
        const from = jsonProjection(tag.from),
          to = jsonProjection(tag.to);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to - from > 100000)
          throw new Error("Invalid fixture range");
        return Array.from(
          { length: Math.max(0, to - from + (tag.exclusive ? 0 : 1)) },
          (_, i) => from + i,
        );
      }
      case "hash":
        return Object.fromEntries(
          tag.entries.map(([k, v]) => [jsonProjection(k), jsonProjection(v)]),
        );
      default:
        throw new Error(`Unknown fixture value type: ${tag.type}`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonProjection(v)]));
}
