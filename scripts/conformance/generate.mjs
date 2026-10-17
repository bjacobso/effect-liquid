export function generate(seed, count, dialect) {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const pick = (values) => values[next() % values.length];
  const atom = () => pick(["x", "y", "'ab'", "' c '", "nil", "true", "false", "1", "2.0"]);
  const expression = () => {
    let source = atom();
    const depth = next() % 3;
    for (let i = 0; i < depth; i++)
      source += pick([
        " | upcase",
        " | escape",
        " | default: 'z'",
        " | plus: 2",
        " | times: 3",
        " | round: 1",
        " | append: '!'",
        " | replace: '', '-'",
        " | truncate: 4",
      ]);
    return source;
  };
  const result = [];
  for (let index = 0; index < count; index++) {
    const out = () => `{{ ${expression()} }}`;
    const templates = { p: "{{item}}/{{shop}};" };
    const source = pick([
      () => out(),
      () => `{% assign a = ${expression()} %}{{a}}/${out()}`,
      () =>
        `{% if ${atom()} ${pick(["==", "!=", ">", "contains"])} ${atom()} %}${out()}{% else %}N{% endif %}`,
      () =>
        `{% for item in xs limit:${next() % 5} %}{{item}}/${out()}{% else %}empty{% endfor %}{{x}}`,
      () => `{% case x %}{% when 1, 1 %}A{% when 2 %}B{% else %}C{% endcase %}`,
      () => `{% capture a %}${out()}-${out()}{% endcapture %}{{a}}`,
      () => `{% render 'p' for xs as item %}`,
      () => `{% assign a = 'A' %}{% cycle a, 'B' %}{% cycle a, 'B' %}`,
      () => `{% increment x %}{{x}}/{% decrement x %}`,
      () =>
        dialect === "ruby"
          ? `{% for item in xs %}{% ifchanged %}{{item}}{% endifchanged %}{% endfor %}`
          : out(),
    ])();
    result.push({
      id: `fuzz:${dialect}:${seed}:${index}`,
      authority: dialect,
      source,
      context: {
        x: next() % 4,
        y: { $liquid: { type: "float", value: "2.0" } },
        xs: Array.from({ length: next() % 5 }, () => next() % 4),
      },
      globals: { shop: "S" },
      templates,
      options: { strictFilters: true },
      operation: "render",
      origin: { repository: "local", path: "scripts/conformance/generate.mjs" },
      generator: { seed, index },
    });
  }
  return result;
}
