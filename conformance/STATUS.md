# Current corpus status

4300 of 6296 executable cases pass without known gaps (68.3%). 1437 cases differ between engines; 1996 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The URL-filter batch resolved 22 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 67.9% to 68.3%. No previously passing case became a known gap, and no upstream expected-result matches were lost. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, 67 for continuation/partial bindings, and 142 for string filters.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
