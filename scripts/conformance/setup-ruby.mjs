import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pins } from "./common.mjs";
const source = resolve(".cache/upstream/shopify-liquid");
const home = resolve(".cache/ruby-gems");
const pin = pins["shopify-liquid"];
const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== pin.commit) throw new Error("Ruby source pin mismatch; run conformance:fetch");
mkdirSync(home, { recursive: true });
for (const [name, version] of [
  ["strscan", "3.1.1"],
  ["bigdecimal", "3.1.3"],
])
  execFileSync(
    "gem",
    [
      "install",
      name,
      "--version",
      version,
      "--no-document",
      "--no-user-install",
      "--install-dir",
      home,
    ],
    { stdio: "inherit" },
  );
const gem = resolve(".cache/liquid-oracle.gem");
execFileSync("gem", ["build", "liquid.gemspec", "--output", gem], {
  cwd: source,
  stdio: "inherit",
});
execFileSync(
  "gem",
  [
    "install",
    gem,
    "--local",
    "--ignore-dependencies",
    "--no-document",
    "--no-user-install",
    "--install-dir",
    home,
  ],
  { stdio: "inherit" },
);
writeFileSync(
  resolve(home, "oracle-pin.json"),
  JSON.stringify(
    { commit: head, version: pin.version, strscan: "3.1.1", bigdecimal: "3.1.3" },
    null,
    2,
  ) + "\n",
);
