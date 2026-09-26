import { expect, test } from "bun:test";
import { en } from "../i18n/en";
import { it } from "../i18n/it";

/*
 * The project search walks the tree once and matches the **names** in it.
 * `findInFiles` exists and can read the content, but nothing outside its own
 * tests calls it, so the box does not search inside files: in `p1-progetto`,
 * «voce» — which is in NOTE.md — answers «Nessun file o cartella corrisponde»,
 * while «no» finds NOTE.md.
 *
 * The two roads were to wire `findInFiles` in, or to say what the box searches.
 * The first is not a one-liner: it needs a decision about which files are read
 * (binary, size, what is ignored), and a search that half-works over a large
 * repository is worse than one that is plainly named. So the placeholder says
 * «per nome», and this test holds it to that.
 */
test("lint: the project search says it looks at names, in both languages", () => {
  expect(it["sidebar.search.project"]).toContain("per nome");
  expect(en["sidebar.search.project"]).toContain("by name");
});

test("lint: the content search is not wired, so the box must not promise one", () => {
  // `findInFiles` is exported and tested, and nothing else calls it. If a caller
  // appears, this test is the place to notice and to change the promise with it.
  expect(typeof it["sidebar.search.project"]).toBe("string");
  expect(it["sidebar.search.project"]).not.toContain("contenuto");
  expect(en["sidebar.search.project"]).not.toContain("content");
});
