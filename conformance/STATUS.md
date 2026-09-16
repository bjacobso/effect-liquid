# Current corpus status

3891 of 6296 executable cases pass without known gaps (61.8%). 1948 cases differ between engines; 2405 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The counter/cycle and initial collection-filter batch resolved 409 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 55.3% to 61.8%. No previously passing case became a known gap. Six Ruby golden assertions that previously passed now differ while matching the pinned LiquidJS behavior (empty-property filtering and permissive cycle parsing); these remain recorded dialect gaps.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
