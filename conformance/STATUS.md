# Current corpus status

4360 of 6296 executable cases pass without known gaps (69.3%). 1365 cases differ between engines; 1936 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The grouped-expression batch resolved 22 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 68.9% to 69.3%. These include 17 successful renders with grouping enabled and five expected parse errors with it disabled. No previously fully passing case became a known gap, and no upstream expected-result matches were lost. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, 67 for continuation/partial bindings, 142 for string filters, 22 for URL filters, 10 for expression filters/static selectors, 8 for numeric filters, and 20 for Base64 filters. The numeric batch deliberately adopted LiquidJS boolean and numeric-prefix coercion over seven previously matching Ruby expectations; those remain recorded dialect gaps.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
