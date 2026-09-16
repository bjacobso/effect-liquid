# Current corpus status

4069 of 6296 executable cases pass without known gaps (64.6%). 1702 cases differ between engines; 2227 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The liquid-block/inline-comment/table-row batch resolved 178 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 61.8% to 64.6%. No previously passing case became a known gap. Two Ruby strict parser assertions now differ while matching LiquidJS's permissive table-row parsing; they remain recorded dialect gaps. The preceding counter/cycle/collection-filter batch resolved 409 cases (55.3% to 61.8%).

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
