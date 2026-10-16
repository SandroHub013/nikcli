/**
 * A command as the user reads it before saying yes: the characters that change how text looks without being seen are
 * written out. A command with U+202E (right-to-left override) in it reads reversed, so `rm -rf` can look like something
 * harmless, while the block list works on the real text and the user approves the one they see. Controls (but not the
 * newline and the tab a command may really have), the marks that set a text's direction, and the zero-width characters
 * become `⟨U+202E⟩`: the command is the same, and what is hidden in it is seen.
 *
 * Used wherever a request is shown to be decided: the list of what waits, the bell, the card in the thread, the phone.
 * The data stays as it was asked: only the display changes.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/g

export function visibleText(text: string): string {
  return text.replace(HIDDEN, (char) => `⟨U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`)
}
