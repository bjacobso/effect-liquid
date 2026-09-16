# Current corpus status

4310 of 6296 executable cases pass without known gaps (68.5%). 1427 cases differ between engines; 1986 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The expression-filter and static-selector batch resolved 10 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 68.3% to 68.5%. No previously passing case became a known gap, and no upstream expected-result matches were lost. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, 67 for continuation/partial bindings, 142 for string filters, and 22 for URL filters.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
