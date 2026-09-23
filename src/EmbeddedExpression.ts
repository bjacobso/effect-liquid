import type { Expression } from "./Ast.js";
import { readExpression } from "./ExpressionParser.js";
import { make, type Span } from "./Source.js";

// Decoded expression strings can have escaped characters. Locate their diagnostics at the
// containing argument instead of inventing precise offsets into the original literal.
export function embeddedExpression(text: string, at: Span, groupedExpressions = false): Expression {
  const visit = (expression: Expression): Expression => {
    const base = { ...expression, span: at };
    switch (expression._tag) {
      case "Access":
        return {
          ...base,
          _tag: "Access",
          receiver: visit(expression.receiver),
          segments: expression.segments.map(visit),
        };
      case "Lookup":
        return {
          ...base,
          _tag: "Lookup",
          root: expression.root,
          segments: expression.segments.map(visit),
        };
      case "Range":
        return { ...base, _tag: "Range", from: visit(expression.from), to: visit(expression.to) };
      case "Binary":
        return {
          ...base,
          _tag: "Binary",
          operator: expression.operator,
          left: visit(expression.left),
          right: visit(expression.right),
        };
      case "Not":
        return { ...base, _tag: "Not", value: visit(expression.value) };
      case "Filter":
        return {
          ...base,
          _tag: "Filter",
          input: visit(expression.input),
          name: expression.name,
          args: expression.args.map(visit),
          named: Object.fromEntries(
            Object.entries(expression.named).map(([name, value]) => [name, visit(value)]),
          ),
        };
      default:
        return base;
    }
  };
  return visit(readExpression(make(text, at.sourceId), groupedExpressions));
}
