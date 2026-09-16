# Current corpus status

4136 of 6296 executable cases pass without known gaps (65.7%). 1613 cases differ between engines; 2160 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The continuation/partial-binding batch resolved 67 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 64.6% to 65.7%. No previously passing case became a known gap. Two Ruby strict parser assertions now differ while matching LiquidJS's permissive render-for parsing; these remain recorded dialect gaps. Earlier batches resolved 409 cases for counters/cycles/collection filters and 178 for liquid blocks/table rows.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
