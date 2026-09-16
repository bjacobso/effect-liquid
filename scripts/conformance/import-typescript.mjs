import ts from "typescript";
import { id, origin } from "./common.mjs";

class Unresolved extends Error {}
const reject = (message) => {
  throw new Unresolved(message);
};
const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const method = (n) =>
  ts.isPropertyAccessExpression(n) ? n.name.text : ts.isIdentifier(n) ? n.text : "";
const cloneEnv = (env) =>
  new Map(
    [...env].map(([key, value]) => [
      key,
      value instanceof Unresolved ? value : structuredClone(value),
    ]),
  );
const jsonSafe = (value, seen = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((v) => jsonSafe(v, seen));
  seen.delete(value);
  return valid;
};
const calls = new Set([
  "parseAndRender",
  "parseAndRenderSync",
  "render",
  "renderSync",
  "parse",
  "test",
]);
export function extractTypeScript(text, path) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const fixtures = [];
  const inventory = [];
  const handled = new Set();
  const position = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf));
  const identity = (n) => {
    const p = position(n);
    return id("liquidjs", path, p.line + 1, p.character);
  };
  const importedHelper = new Set();
  for (const s of sf.statements)
    if (ts.isImportDeclaration(s) && /stub\/render$/.test(s.moduleSpecifier.text))
      for (const e of s.importClause?.namedBindings?.elements ?? [])
        importedHelper.add(e.name.text);
  const candidate = (n) =>
    ts.isCallExpression(n) &&
    calls.has(method(n.expression)) &&
    (ts.isPropertyAccessExpression(n.expression) || importedHelper.has(method(n.expression)));
  function evaluate(n, env) {
    if (!n) return undefined;
    if (
      ts.isAwaitExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n)
    )
      return evaluate(n.expression, env);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (n.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(n)) {
      if (n.text === "undefined") return undefined;
      if (!env.has(n.text)) return reject(`Unresolved identifier: ${n.text}`);
      const v = env.get(n.text);
      if (v instanceof Unresolved) throw v;
      return v;
    }
    if (ts.isTemplateExpression(n)) {
      let value = n.head.text;
      for (const s of n.templateSpans)
        value += String(evaluate(s.expression, env)) + s.literal.text;
      return value;
    }
    if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => evaluate(e, env));
    if (ts.isObjectLiteralExpression(n)) {
      const out = {};
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          const name = ts.isComputedPropertyName(p.name)
            ? evaluate(p.name.expression, env)
            : p.name.text;
          if (name === "__proto__") reject("Host prototype semantics require an adapter");
          out[name] = evaluate(p.initializer, env);
        } else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = evaluate(p.name, env);
        else if (ts.isSpreadAssignment(p)) Object.assign(out, evaluate(p.expression, env));
        else reject("Accessor or method in context");
      }
      return out;
    }
    if (ts.isPrefixUnaryExpression(n)) {
      const v = evaluate(n.operand, env);
      if (n.operator === ts.SyntaxKind.MinusToken) return -v;
      if (n.operator === ts.SyntaxKind.PlusToken) return +v;
      if (n.operator === ts.SyntaxKind.ExclamationToken) return !v;
    }
    if (ts.isBinaryExpression(n)) {
      const a = evaluate(n.left, env);
      const b = evaluate(n.right, env);
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return a + b;
        case ts.SyntaxKind.MinusToken:
          return a - b;
        case ts.SyntaxKind.AsteriskToken:
          return a * b;
        case ts.SyntaxKind.SlashToken:
          return a / b;
        default:
          return reject("Unsupported binary expression");
      }
    }
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "Liquid")
      return { engine: true, options: n.arguments?.[0] ? evaluate(n.arguments[0], env) : {} };
    if (ts.isPropertyAccessExpression(n)) {
      const value = evaluate(n.expression, env);
      return Object.hasOwn(value, n.name.text)
        ? value[n.name.text]
        : reject(`Unresolved property: ${n.name.text}`);
    }
    if (ts.isElementAccessExpression(n)) {
      const value = evaluate(n.expression, env);
      const key = evaluate(n.argumentExpression, env);
      return Object.hasOwn(value, key) ? value[key] : reject(`Unresolved key: ${key}`);
    }
    if (ts.isCallExpression(n)) {
      const name = method(n.expression);
      if (candidate(n)) return capture(n, env);
      if (name === "expect") return { expect: evaluate(n.arguments[0], env) };
      if (
        ["toBe", "toEqual", "toThrow", "toMatch"].includes(name) &&
        ts.isPropertyAccessExpression(n.expression)
      ) {
        let target = n.expression.expression;
        let rejection = false;
        let negation = false;
        while (
          ts.isPropertyAccessExpression(target) &&
          ["resolves", "rejects", "not"].includes(target.name.text)
        ) {
          if (target.name.text === "rejects") rejection = true;
          if (target.name.text === "not") negation = true;
          target = target.expression;
        }
        const wrapper = evaluate(target, env);
        const fixture = wrapper?.expect?.fixture;
        if (fixture && !negation) {
          if (rejection || name === "toThrow") fixture.expected = { kind: "error" };
          else if (name !== "toMatch") {
            const output = evaluate(n.arguments[0], env);
            if (typeof output === "string") fixture.expected = { kind: "output", output };
          }
        }
        return undefined;
      }
      if (ts.isPropertyAccessExpression(n.expression) && ["toString", "join"].includes(name)) {
        const value = evaluate(n.expression.expression, env);
        if (name === "toString" && ["string", "number", "boolean"].includes(typeof value))
          return String(value);
        if (name === "join" && Array.isArray(value))
          return value.join(n.arguments[0] ? evaluate(n.arguments[0], env) : ",");
      }
      return reject(`Unsupported call: ${name || n.expression.getText(sf)}`);
    }
    if (isFn(n)) {
      if (ts.isBlock(n.body)) {
        let value;
        for (const s of n.body.statements) value = statement(s, env);
        return value;
      }
      return evaluate(n.body, env);
    }
    return reject(`Unsupported AST: ${ts.SyntaxKind[n.kind]}`);
  }
  function capture(n, env) {
    const key = identity(n);
    if (handled.has(key)) return { fixture: fixtures.find((f) => f.id === key) };
    handled.add(key);
    const p = position(n);
    const base = { id: key, origin: origin("liquidjs", path, p.line + 1), call: n.getText(sf) };
    try {
      if (env.has("__setupFailure"))
        reject(`Unsupported test setup: ${env.get("__setupFailure").message}`);
      const name = method(n.expression);
      const helper = ts.isIdentifier(n.expression) && importedHelper.has(name);
      let source,
        context = {},
        options = {},
        expected,
        operation = "render";
      if (helper) {
        source = evaluate(n.arguments[0], env);
        if (name === "test") {
          const second = evaluate(n.arguments[1], env);
          if (typeof second === "string") {
            expected = { kind: "output", output: second };
          } else {
            context = second;
            const output = evaluate(n.arguments[2], env);
            if (typeof output !== "string") reject("Nonliteral/regex expected output");
            expected = { kind: "output", output };
          }
          if (n.arguments[3]) options = evaluate(n.arguments[3], env);
        } else context = n.arguments[1] ? evaluate(n.arguments[1], env) : {};
      } else {
        const engine = evaluate(n.expression.expression, env);
        if (!engine?.engine) reject("Receiver is not a statically configured Liquid instance");
        if (engine.custom) reject("Custom tag/filter/plugin or filesystem setup required");
        options = engine.options;
        const arg = evaluate(n.arguments[0], env);
        if (name === "parse") {
          source = arg;
          operation = "parse";
        } else if (name === "render" || name === "renderSync") {
          if (arg?.fixture?.operation !== "parse")
            reject("Render input is not a statically parsed template");
          source = arg.fixture.source;
        } else source = arg;
        context = n.arguments[1] ? evaluate(n.arguments[1], env) : {};
        if (n.arguments[2]) reject("Per-render options require an adapter");
      }
      if (typeof source !== "string") reject("Template is not a static string");
      if (!context || Array.isArray(context) || typeof context !== "object")
        reject("Context must be a JSON record");
      // Never coerce non-JSON contexts (Dates, promises, functions, undefined) into different inputs.
      if (!jsonSafe({ context, options })) reject("Non-JSON input");
      const fixture = {
        id: key,
        source,
        context: structuredClone(context),
        options: structuredClone(options),
        operation,
        origin: base.origin,
        ...(expected ? { expected } : {}),
        suite: "upstream-test",
      };
      fixtures.push(fixture);
      inventory.push({ ...base, status: "imported" });
      return { fixture };
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      inventory.push({ ...base, status: "excluded", reason: error.message });
      return reject(error.message);
    }
  }
  function statement(s, env) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) {
          try {
            env.set(d.name.text, evaluate(d.initializer, env));
          } catch (e) {
            if (!(e instanceof Unresolved)) throw e;
            env.set(d.name.text, e);
          }
        }
      return;
    }
    if (ts.isExpressionStatement(s)) {
      const e = s.expression;
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(e.left)
      ) {
        try {
          env.set(e.left.text, evaluate(e.right, env));
        } catch (error) {
          if (!(error instanceof Unresolved)) throw error;
          env.set(e.left.text, error);
        }
        return;
      }
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(e.left) || ts.isElementAccessExpression(e.left))
      ) {
        const object = evaluate(e.left.expression, env);
        const key = ts.isPropertyAccessExpression(e.left)
          ? e.left.name.text
          : evaluate(e.left.argumentExpression, env);
        if (key === "__proto__") reject("Host prototype mutation requires an adapter");
        object[key] = evaluate(e.right, env);
        return;
      }
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        ["registerFilter", "registerTag", "unregisterFilter", "unregisterTag", "plugin"].includes(
          e.expression.name.text,
        )
      ) {
        try {
          const engine = evaluate(e.expression.expression, env);
          engine.custom = true;
        } catch {}
        return;
      }
      return evaluate(e, env);
    }
    if (ts.isReturnStatement(s)) return evaluate(s.expression, env);
    if (ts.isEmptyStatement(s)) return;
    return reject(`Unsupported statement: ${ts.SyntaxKind[s.kind]}`);
  }
  function scope(statements, parent) {
    const env = cloneEnv(parent);
    const hooks = [];
    for (const s of statements) {
      if (ts.isVariableStatement(s)) {
        statement(s, env);
        continue;
      }
      if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
      const call = s.expression;
      const name = method(call.expression);
      const fn = call.arguments.find(isFn);
      if (name === "afterEach" || name === "afterAll") continue;
      if (name === "beforeEach" || name === "beforeAll") {
        if (fn) hooks.push(fn);
        continue;
      }
      if (name === "describe" && fn) {
        const child = cloneEnv(env);
        for (const hook of hooks) execute(hook, child);
        scope(ts.isBlock(fn.body) ? fn.body.statements : [], child);
      } else if ((name === "it" || name === "test") && fn) {
        const child = cloneEnv(env);
        for (const hook of hooks) execute(hook, child);
        execute(fn, child);
      } else {
        try {
          statement(s, env);
        } catch (e) {
          if (!(e instanceof Unresolved)) throw e;
          env.set("__setupFailure", e);
        }
      }
    }
  }
  function execute(fn, env) {
    if (ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) {
        try {
          statement(s, env);
        } catch (e) {
          if (!(e instanceof Unresolved)) throw e;
          env.set("__setupFailure", e);
        }
      }
    } else {
      try {
        evaluate(fn.body, env);
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
        env.set("__setupFailure", e);
      }
    }
  }
  scope(sf.statements, new Map());
  function scan(n) {
    if (candidate(n) && !handled.has(identity(n))) {
      const p = position(n);
      inventory.push({
        id: identity(n),
        origin: origin("liquidjs", path, p.line + 1),
        call: n.getText(sf),
        status: "excluded",
        reason: "Unsupported test control flow or unresolved surrounding expression",
      });
    }
    ts.forEachChild(n, scan);
  }
  scan(sf);
  return { fixtures, inventory };
}
