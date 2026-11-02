/**
 * The size a process is born at when its pane has not been fitted: the host's default, `pty_spawn`'s.
 *
 * One place for both sides. A terminal made while its pane is not drawn used to be xterm's own 80x24 while the
 * process was told 120x30, so a `--resume` laid its history out at 120 columns into 80 (audit 2026-11-02, SES-9).
 */
export const DEFAULT_PTY_COLS = 120
export const DEFAULT_PTY_ROWS = 30
