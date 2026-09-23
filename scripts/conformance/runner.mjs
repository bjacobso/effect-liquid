import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hash } from "./common.mjs";
export class EngineWorker {
  constructor(
    engine,
    { timeoutMs = 2000, workerPath = new URL("./worker.mjs", import.meta.url) } = {},
  ) {
    this.engine = engine;
    this.timeoutMs = timeoutMs;
    this.workerPath = workerPath;
    this.sequence = 0;
    this.child = undefined;
  }
  async start() {
    if (this.child) return this.child;
    const child = fork(fileURLToPath(this.workerPath), [this.engine], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: ["--max-old-space-size=256"],
      env: { ...process.env, TZ: "UTC", LANG: "C.UTF-8" },
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-2000);
    });
    child.diagnostic = () => stderr;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error("Worker startup timeout"));
      }, 10000);
      const message = (m) => {
        if (m.ready) {
          cleanup();
          resolve();
        }
      };
      const exit = () => {
        cleanup();
        reject(new Error(`Worker startup failed: ${stderr}`));
      };
      const error = (e) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
        child.off("error", error);
      };
      child.on("message", message);
      child.on("exit", exit);
      child.on("error", error);
    });
    this.child = child;
    return child;
  }
  async run(fixture) {
    let child;
    try {
      child = await this.start();
    } catch (error) {
      return { kind: "worker-error", message: error.message };
    }
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
        child.off("error", error);
        resolve(result);
      };
      const message = (m) => {
        if (m.id === id) finish(m.result);
      };
      const exit = (code, signal) => {
        this.child = undefined;
        finish({ kind: "worker-crash", code, signal, message: child.diagnostic() });
      };
      const error = (e) => {
        this.child = undefined;
        finish({ kind: "worker-error", message: e.message });
      };
      const timer = setTimeout(() => {
        this.child = undefined;
        finish({ kind: "timeout", timeoutMs: this.timeoutMs });
        child.kill("SIGKILL");
      }, this.timeoutMs);
      child.on("message", message);
      child.once("exit", exit);
      child.once("error", error);
      child.send({ id, fixture }, (error) => {
        if (error) {
          this.child = undefined;
          finish({ kind: "worker-error", message: error.message });
        }
      });
    });
  }
  close() {
    this.child?.kill();
    this.child = undefined;
  }
}
export function compare(left, right) {
  if (left.kind === "output" && right.kind === "output" && left.sha256 === right.sha256)
    return "match-output";
  if (left.kind === "parsed" && right.kind === "parsed") return "match-parse";
  if (
    left.kind === "error" &&
    right.kind === "error" &&
    left.category === right.category &&
    left.phase === right.phase
  )
    return "match-error";
  return "mismatch";
}
export function expectation(result, expected) {
  if (!expected) return "not-specified";
  if (expected.kind === "output")
    return result.kind === "output" &&
      result.sha256 === hash(Buffer.from(expected.output, "utf16le"))
      ? "match"
      : "different";
  if (expected.kind === "error")
    return result.kind === "error" && (!expected.phase || result.phase === expected.phase)
      ? "match"
      : "different";
  return "not-specified";
}
export function signature(result) {
  switch (result.kind) {
    case "output":
      return { kind: result.kind, sha256: result.sha256 };
    case "error":
      return {
        kind: result.kind,
        phase: result.phase,
        category: result.category,
        message: result.message,
      };
    case "unsupported-configuration":
      return { kind: result.kind, options: result.options };
    default:
      return { kind: result.kind };
  }
}
export function baselineEntry(fixture, left, right) {
  return {
    fixtureHash: hash(fixture),
    liquidjs: signature(left),
    effectLiquid: signature(right),
    reason:
      right.kind === "unsupported-configuration"
        ? "Unsupported engine option"
        : right.kind === "error" && right.category === "unknown-tag"
          ? "Tag not implemented"
          : "Known imported compatibility gap; inspect the linked upstream case",
  };
}
export function hasGap(fixture, left, right) {
  return (
    compare(left, right) === "mismatch" ||
    expectation(left, fixture.expected) === "different" ||
    expectation(right, fixture.expected) === "different"
  );
}
export function regression(fixture, left, right, baseline) {
  const entry = baseline?.[fixture.id];
  if (!hasGap(fixture, left, right)) return entry ? "improved" : "pass";
  if (!entry) return "new-gap";
  const actual = baselineEntry(fixture, left, right);
  const oracleMatches =
    right.kind === "unsupported-configuration" && entry.effectLiquid.kind === right.kind
      ? entry.liquidjs.kind === actual.liquidjs.kind
      : JSON.stringify(entry.liquidjs) === JSON.stringify(actual.liquidjs);
  return entry.fixtureHash === actual.fixtureHash &&
    oracleMatches &&
    JSON.stringify(entry.effectLiquid) === JSON.stringify(actual.effectLiquid)
    ? "known-gap"
    : "changed-gap";
}
