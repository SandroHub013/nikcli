/**
 * The «Held message from another session» window of Claude Code, as raw pty chunks. NOT a live capture: written from the screenshot
 * `ade-team/prove/sessioni2-mode-2/05-diretto-trattenuto.png` (text and layout), with the cursor moves and colours Claude Code uses
 * for the mode bar (`mode-bar-raw.ts`). The window replaces the input box and the mode bar under it; when it closes the input box and
 * the bar are painted again. Replace with a real capture when one is taken.
 */
export const heldDialogRaw: string[] = [
  // The explanation and the heading, painted with cursor moves and no newline between the words of a line.
  "\u001b[?25l\u001b[H\u001b[2J\u001b[33mclaims name: Sessione 1 Claude Code); preview: «ping-p2-diretto» - not delivered to Claude (1 held).\u001b[39m\u001b[7;1H" +
    "\u001b[34;1mHeld\u001b[1Cmessage\u001b[1Cfrom\u001b[1Canother\u001b[1Csession\u001b[22;39m\u001b[9;1H",
  // The body and the choices, the first one selected.
  "Another Claude session sent a message: from uds:\\\\.\\pipe\\LOCAL\\cc-msg-10cbe4fdad6ecdd3e08fc2031d308488\u001b[11;1H" +
    "The sending session's permission mode class doesn't match this session's, so it wasn't delivered automatically.\u001b[14;1H" +
    "ping-p2-diretto, non rispondere\u001b[16;1H\u001b[34m❯ Deny — drop it and tell the sender it was declined\u001b[39m\u001b[17;1H  Deliver this message to Claude\u001b[?25h",
]

/** What Claude Code paints when the window is gone: the input box again and the mode bar under it (as in `mode-bar-raw.ts`). */
export const afterHeldDialogRaw =
  "\u001b[?25l\u001b[H\u001b[2J\u001b[38;2;102;102;102m───\u001b[20;1H❯ \u001b[21;1H⏵⏵ bypass permissions on (shift+tab to cycle)\u001b[39m\u001b[K\u001b[18;3H\u001b[?25h"
