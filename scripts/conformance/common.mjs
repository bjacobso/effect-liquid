import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
export const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
export function files(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.name === ".git" ? [] : e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)],
    )
    .sort();
}
export const pins = readJSON(new URL("../../conformance/upstreams.json", import.meta.url));
export function origin(repo, path, line) {
  const pin = pins[repo];
  return {
    repository: repo,
    commit: pin.commit,
    path,
    line,
    url: `${pin.repository}/blob/${pin.commit}/${path}#L${line}`,
    license: path.startsWith("docs/") ? "CC-BY-4.0" : pin.license,
  };
}
export function id(repo, path, line, column = 0) {
  return `${repo}:${path}:${line}:${column}`;
}
