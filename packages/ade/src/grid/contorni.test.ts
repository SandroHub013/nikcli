import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";

/*
 * No green outlines, in any theme (contorni-e-statusline, parte A). The user:
 * «rimuoviamo i contorni verdi da tutti i temi… non lo vogliamo».
 *
 * The accent stays where it is not an outline — solid primary buttons, links,
 * state indicators — so this does not forbid `--ade-accent` everywhere. It
 * forbids it in the three properties that draw a contour, in the rules that
 * draw a pane's focus, and it does it on the parsed sheet rather than on the
 * text, so a reformat cannot hide a declaration.
 *
 * Two accents are deliberately left, and each is named below so a reader knows
 * they were looked at rather than missed: the dashed drop zone in index.css and
 * the accent underline on the pane title while it is being renamed.
 */

const src = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(src, file), "utf-8");
const sheet = (file: string) => postcss.parse(read(file));

/** `--ade-accent` and its glow, in the properties that draw a contour. */
const CONTOUR = /^(border|border-.*|outline|outline-.*|box-shadow)$/;

/** The rules that draw a pane's focus. */
const FOCUS_RULES = [
  {
    file: "index.css",
    selector: '[data-slot="grid-cell"] > [data-component][data-focused]',
  },
  {
    file: "grid/pane.css",
    selector: '[data-component="session-pane"][data-focused]',
  },
  {
    file: "grid/pane.css",
    selector:
      '[data-component="session-pane"][data-focused] > [data-slot="pane-header"]',
  },
];

describe("lint: no pane draws its focus in accent", () => {
  test("lint: the focused pane's line, the session's ring and its header's edge are the neutral border", () => {
    for (const { file, selector } of FOCUS_RULES) {
      let found = 0;
      sheet(file).walkRules(selector, (rule) => {
        found++;
        for (const node of rule.nodes) {
          if (node.type !== "decl" || !CONTOUR.test(node.prop)) continue;
          const offenders = [node.prop, node.value].filter((value) =>
            /var\(--ade-accent/.test(value),
          );
          expect([`${file} ${selector}`, offenders]).toEqual([
            `${file} ${selector}`,
            [],
          ]);
        }
      });
      // The rule has to be there: a renamed slot would otherwise pass on a `false`.
      expect([`${file} ${selector}`, found]).toEqual([
        `${file} ${selector}`,
        1,
      ]);
    }
  });

  test("lint: the focus ring token is grey in every theme, not the accent", () => {
    // The one declaration every sheet reaches for. It is defined once, so this is
    // where the ~20 focus rings change at the same time.
    const values: string[] = [];
    sheet("index.css").walkDecls("--ade-focus-ring", (decl) => {
      values.push(decl.value);
    });
    expect([values.length, values.length > 0]).toEqual([values.length, true]);
    for (const value of values) {
      const offenders = [value].filter((one) => /var\(--ade-accent/.test(one));
      expect(offenders).toEqual([]);
      // And it is a real grey, so the focus is still visible: it steps up from
      // the resting border rather than becoming nothing.
      expect(value).toContain("var(--ade-border-strong)");
    }
    // The old definition, so the change is what a reader sees when they look.
    expect(read("index.css")).not.toContain("0 0 0 2px var(--ade-accent)");
  });

  test("lint: the neutral token has a light-dark value, so the ring follows the theme", () => {
    // A ring that reads an undefined token draws nothing, and a focus that draws
    // nothing is the accessibility cost of this change. ADE's themes are `light`,
    // `dark`, `system` and `glass`, and the token carries `light-dark()`, so the
    // ring follows `color-scheme` in every one of them without a rule per theme.
    //
    // Only that one declaration needs it: the plain value beside it is the
    // fallback for a UA without `light-dark()`, and the later rule wins. So this
    // asks that a `light-dark()` value exists, not that every one carries it.
    const decls: string[] = [];
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      sheet(entry.replace(/\\/g, "/")).walkDecls(
        "--ade-border-strong",
        (decl) => {
          decls.push(decl.value);
        },
      );
    }
    expect([decls.length, decls.length > 0]).toEqual([decls.length, true]);
    expect([decls.some((value) => value.includes("light-dark("))]).toEqual([
      true,
    ]);
    // And no theme's grey is the accent, wherever it is written.
    expect(decls.filter((value) => /var\(--ade-accent/.test(value))).toEqual(
      [],
    );
  });
});

/*
 * Left on purpose, and named so a reader can tell they were read:
 *
 * - `index.css` the drop zone: `border: 2px dashed var(--ade-accent)` with a
 *   tinted ground. A dashed border and a wash of colour say «drop here», which
 *   is a state indicator, not a focus contour.
 * - `grid/pane.css` the pane title while it is being renamed:
 *   `box-shadow: inset 0 -1.5px 0 var(--ade-accent)`. It says «you are typing
 *   here» for as long as the rename lasts, and vanishes after it.
 */
describe("lint: the accents that are not contours stay", () => {
  test("lint: the drop zone and the rename underline are the only two left in the panes' sheets", () => {
    const left: string[] = [];
    for (const file of ["index.css", "grid/pane.css"]) {
      sheet(file).walkDecls((decl) => {
        if (!CONTOUR.test(decl.prop) || !/var\(--ade-accent/.test(decl.value))
          return;
        const selector =
          decl.parent?.type === "rule"
            ? (decl.parent as postcss.Rule).selector
            : "";
        if (/drop|drag/.test(selector) || /pane-title-input/.test(selector))
          return;
        left.push(`${file} ${decl.prop} in ${selector}`);
      });
    }
    expect(left).toEqual([]);
  });
});
