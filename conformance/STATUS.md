# Current corpus status

4278 of 6296 executable cases pass without known gaps (67.9%). 1465 cases differ between engines; 2018 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The string-filter batch resolved 142 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 65.7% to 67.9%. No previously passing case became a known gap. Two Ruby truncatewords expectations now differ while matching the pinned LiquidJS behavior; both remain recorded dialect gaps. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, and 67 for continuation/partial bindings.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
