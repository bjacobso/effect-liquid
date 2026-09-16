import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { pins } from "./common.mjs";

mkdirSync(".cache/upstream", { recursive: true });
for (const [name, pin] of Object.entries(pins)) {
  const root = `.cache/upstream/${name}`;
  if (!existsSync(`${root}/.git`)) execFileSync("git", ["init", "--quiet", root]);
  let head = "";
  try {
    head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  if (head !== pin.commit) {
    execFileSync(
      "git",
      ["-C", root, "fetch", "--quiet", "--depth", "1", `${pin.repository}.git`, pin.commit],
      { stdio: "inherit" },
    );
    execFileSync("git", ["-C", root, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  }
  process.stdout.write(`${name}: ${pin.commit}\n`);
}
