# Current corpus status

4374 of 6296 executable cases pass without known gaps (69.5%). 1346 cases differ between engines; 1922 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The sentence-formatting and concatenation-error batch resolved 8 cases on the unchanged 6,296-case corpus, increasing full passes from 4,366 (69.3%) to 4,374 (69.5%). No previously fully passing case became a known gap, and no upstream expected-result matches were lost. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, 67 for continuation/partial bindings, 142 for string filters, 22 for URL filters, 10 for expression filters/static selectors, 8 for numeric filters, 20 for Base64 filters, 22 for grouped expressions, and 6 for property lookup. The numeric batch deliberately adopted LiquidJS boolean and numeric-prefix coercion over seven previously matching Ruby expectations; those remain recorded dialect gaps.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
