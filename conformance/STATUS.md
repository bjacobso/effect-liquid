# Current corpus status

4318 of 6296 executable cases pass without known gaps (68.6%). 1412 cases differ between engines; 1978 cases have a recorded gap against either engine agreement or upstream expectations. There were 0 worker failures.

The numeric-filter batch resolved 8 cases on the unchanged 6,296-case corpus, increasing the full pass rate from 68.5% to 68.6%. No previously fully passing case became a known gap. Seven existing gaps now match LiquidJS but lose their Ruby expected-result match: four boolean conversions in liquid-spec and three copies of a numeric-prefix coercion example across the Ruby corpora. These deliberately follow the pinned LiquidJS dialect and remain recorded gaps; the baseline update does not count them as full passes. Earlier batches resolved 409 cases for counters/cycles/collection filters, 178 for liquid blocks/table rows, 67 for continuation/partial bindings, 142 for string filters, 22 for URL filters, and 10 for expression filters/static selectors.

The baseline regression gate passes. Strict full conformance does not pass. Run `pnpm conformance` for current per-case results and linked upstream sources. Scanned source files: 529; see the import inventory for imported, excluded, and catalogued candidates.
