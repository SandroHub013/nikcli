/**
 * Two raw pty chunks as ADE received them from Claude Code (live capture, `pty:data` events): the mode bar repainted on Shift+Tab, with
 * no newline in either. First "auto mode", then "manual mode".
 */
export const modeBarRaw: string[] = [
  "\u001b[?25l\u001b[H\r\u001b[2C\u001b[20B\u001b[38;2;150;108;30m⏵⏵ auto mode on\u001b[38;2;102;102;102m (shift+tab to cycle) ·\u001b[42G← 1 agent\u001b[39m\u001b[K\u001b[21;1H\u001b[18;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[2C\u001b[20B\u001b[38;2;102;102;102m⏸ manual mode on · ← 1 agen\u001b[31G\u001b[39m\u001b[K\u001b[21;1H\u001b[18;3H\u001b[?25h",
]
