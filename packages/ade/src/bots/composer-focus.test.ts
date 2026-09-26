import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * DS-chat 1, «campo nero»: il campo in cui si scrive a un bot, e quello della
 * Chat, non si colorano di verde al focus. Il bordo sale di una sfumatura
 * rispetto a quello di riposo e l'alone che tiene visibile il focus da
 * tastiera è grigio. Niente anello teal, niente bordo accent, niente ombra
 * colorata.
 *
 * È un `lint:` sul foglio di stile, non una prova di comportamento: la regola
 * riguarda ciò che il foglio dice, quindi si controlla il foglio (TEAM.md,
 * regola 22). I colori che la regola indica sono token di tema, ed è questo il
 * motivo per cui vale anche nel tema chiaro: `--ade-border-strong` è un grigio
 * in entrambi, mentre `--ade-accent` e `--ade-focus-ring` sono teal in entrambi.
 */

/** The stylesheet, comments out: a note about the rule is not the rule. */
const sheet = (...path: string[]) =>
  readFileSync(join(import.meta.dir, ...path), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

const bots = sheet("bots.css");
const chat = sheet("..", "chat", "chat.css");

/** The declarations of the rule whose selector is `selector`, braces excluded. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^[^\\S\\n]*${escaped}[^{]*\\{([^}]*)\\}`, "m").exec(
    css,
  );
  // The rule has to be there: a renamed slot would otherwise pass on a `false`.
  expect([selector, found !== null]).toEqual([selector, true]);
  return found![1]!;
}

const BOT_FOCUS = '[data-slot="bots-composer"]:focus-within';
const CHAT_FOCUS = '[data-slot="chat-input"]:focus-visible';

describe("lint: i due composer non si colorano al focus", () => {
  test("lint: the bot's composer draws no accent at the focus, only a grey border", () => {
    const body = rule(bots, BOT_FOCUS);
    expect([body, body.includes("--ade-accent")]).toEqual([body, false]);
    expect([body, body.includes("--ade-focus-ring")]).toEqual([body, false]);
    expect(body).toContain("border-color: var(--ade-border-strong)");
  });

  test("lint: the Chat's field draws no accent at the focus, only a grey border", () => {
    const body = rule(chat, CHAT_FOCUS);
    expect([body, body.includes("--ade-accent")]).toEqual([body, false]);
    expect([body, body.includes("--ade-focus-ring")]).toEqual([body, false]);
    expect(body).toContain("border-color: var(--ade-border-strong)");
  });

  test("lint: the halo that keeps the keyboard focus visible is grey in both", () => {
    const bodies = [rule(bots, BOT_FOCUS), rule(chat, CHAT_FOCUS)];
    // Rule 22: a cycle over a list checks the list is not empty first.
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatch(
        /box-shadow:\s*0 0 0 2px color-mix\(in srgb, var\(--ade-border-strong\) \d+%,\s*transparent\)/,
      );
    }
  });

  test("lint: the two fields rest on the dark surface of their theme, not on a tint", () => {
    // The base of each field: unchanged by the focus, and not painted with the
    // accent either. Without this the rule above could hold on a coloured box.
    for (const [css, selector] of [
      [bots, '[data-slot="bots-composer"]'],
      [chat, '[data-slot="chat-input"]'],
    ] as const) {
      const body = rule(css, selector);
      expect([selector, body.includes("--ade-accent")]).toEqual([
        selector,
        false,
      ]);
      expect(body).toMatch(
        /(background:\s*var\(--ade-surface\)|background:\s*var\(--ade-raised\))/,
      );
    }
  });
});
