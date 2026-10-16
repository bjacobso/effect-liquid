# Parser compatibility gaps

The pinned LiquidJS parser and the Ruby expectations in `liquid-spec` disagree on many malformed templates. The harness keeps both outcomes visible. A parse-only fixture can match LiquidJS and still remain a known gap against its Ruby expectation.

The pre-roadmap report had 923 mismatches from `specs/parser_errors`: in 921, LiquidJS parses and effect-liquid rejects with a syntax error; in two comment cases, LiquidJS rejected and effect-liquid parsed. The largest parse-versus-error groups are include (123), render (109), cycle (92), unless (81), if (80), assign (66), echo (63), for (62), table row (61), and output variables (55). These counts describe parser permissiveness, not necessarily valid render behavior.

The parser now accepts bare bracket context lookups such as `{{ ["name"] }}` and loop control inside a `for` `else` branch. It classifies malformed raw/comment tag arguments as syntax errors. These changes match pinned LiquidJS cases without broadly accepting malformed expressions. Bare bracket cases where Ruby expects an error remain explicit dialect gaps.

The two opposite mismatches are comment bodies with an unclosed raw block or output delimiter. LiquidJS tokenizes enough of those bodies to reject them; effect-liquid currently skips comment bodies. The roadmap batch adds a bounded lexical scan, including raw blocks that cross apparent comment closers, and resolves these two cases. The 921 intentional malformed-syntax rejections remain. Other parse-versus-error groups should be sampled and grouped by grammar rule before changing parser recovery, then tested against both parse and render behavior.

Raw/endraw trim markers preserve literal body whitespace using Ruby semantics. Early malformed endraw openers close only at the complete tag, also following Ruby. Include `for` and `with/as` follow Ruby iteration/alias semantics by owner choice; LiquidJS 10.29.0 renders once with boolean hash arguments instead. Both engine results and Ruby expectations remain visible in the report.

The remaining-mismatch audit preserves all 920 current parse-only intentional rejections and all 10 raw/endraw dialect cases. It resolves the two imported comment cases with stray closing-brace text after the tag name by scanning through complete delimiters, and trims inline-comment argument whitespace before validating subsequent lines. Spaced receiver suffixes remain syntactically validated but do not participate in rendering, analysis, or checking after whitespace ends the receiver path, matching the pin.

Phase 2 makes these owner choices dialect-specific: Ruby keeps its include/raw behavior and the default LiquidJS profile uses the pinned include/hash and raw scanning rules. Conformance executes each fixture in its authority dialect; cross-engine parser disagreements no longer lower the Ruby score. Permissive LiquidJS grammar remains a separate Phase 6.
