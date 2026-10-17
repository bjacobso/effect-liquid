import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readJSON, pins } from "./common.mjs";
export async function rubyEngine() {
  const pin = readJSON(".cache/ruby-gems/oracle-pin.json");
  if (
    pin.commit !== pins["shopify-liquid"].commit ||
    pin.version !== pins["shopify-liquid"].version
  )
    throw new Error("Ruby oracle pin mismatch; run pnpm conformance:ruby:setup");
  const child = spawn("ruby", [fileURLToPath(new URL("./ruby-worker.rb", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TZ: "UTC", LANG: "C.UTF-8" },
  });
  child.stdin.on("error", () => process.exit(1));
  let sequence = 0,
    diagnostic = "";
  const pending = new Map();
  child.stderr.on("data", (v) => {
    diagnostic = (diagnostic + v).slice(-2000);
  });
  process.on("exit", () => child.kill("SIGKILL"));
  process.on("disconnect", () => {
    child.kill("SIGKILL");
    process.exit(0);
  });
  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready) resolve();
        else {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done?.(message.result);
        }
      } catch (error) {
        reject(error);
      }
    });
    child.on("error", reject);
    child.on("exit", () => {
      reject(new Error(`Ruby oracle exited: ${diagnostic}`));
      for (const done of pending.values()) done({ kind: "worker-crash", message: diagnostic });
      pending.clear();
      process.exit(1);
    });
  });
  return (fixture) =>
    new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, fixture }) + "\n");
    });
}
