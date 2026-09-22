# Parser compatibility gaps

The pinned LiquidJS parser and the Ruby expectations in `liquid-spec` disagree on many malformed templates. The harness keeps both outcomes visible. A parse-only fixture can match LiquidJS and still remain a known gap against its Ruby expectation.

The current report has 923 mismatches from `specs/parser_errors`: in 921, LiquidJS parses and effect-liquid rejects with a syntax error; in two comment cases, LiquidJS rejects and effect-liquid parses. The largest parse-versus-error groups are include (123), render (109), cycle (92), unless (81), if (80), assign (66), echo (63), for (62), table row (61), and output variables (55). These counts describe parser permissiveness, not necessarily valid render behavior.

The parser now accepts bare bracket context lookups such as `{{ ["name"] }}` and loop control inside a `for` `else` branch. It classifies malformed raw/comment tag arguments as syntax errors. These changes match pinned LiquidJS cases without broadly accepting malformed expressions. Bare bracket cases where Ruby expects an error remain explicit dialect gaps.

The two opposite mismatches are comment bodies with an unclosed raw block or output delimiter. LiquidJS tokenizes enough of those bodies to reject them; effect-liquid currently skips comment bodies. They need a bounded comment-body lexical check. Other parse-versus-error groups should be sampled and grouped by grammar rule before changing parser recovery, then tested against both parse and render behavior.
