import { dlopen, ptr } from "bun:ffi";

const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const ENABLE_PROCESSED_INPUT = 0x0001;
const ENABLE_PROCESSED_OUTPUT = 0x0001;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const CP_UTF8 = 65001;

export const TERMINAL_RESET_SEQUENCE =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?25h\x1b[0m";

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
    SetConsoleOutputCP: { args: ["u32"], returns: "i32" },
  });

let k32: ReturnType<typeof kernel> | undefined;

export function shouldUseRendererThread(
  platform: NodeJS.Platform = process.platform,
) {
  return platform !== "win32";
}

/**
 * Whether an overlay has to ask for a full repaint after it opens.
 *
 * Same root cause as `shouldUseRendererThread`: on Windows the console pipe
 * drops part of a large frame, and OpenTUI only writes the cells that changed
 * since the previous frame. Cells whose write was lost are never retried, so
 * the rows the terminal missed keep showing the *previous* screen until
 * something forces a full repaint. An opening dialog is the worst case — the
 * frame is nearly full-screen, and what shows through is the view behind it.
 */
export function shouldForceOverlayRepaint(
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32";
}

/**
 * Terminals that draw `█▀▄` at one column, so a half-block QR stays square.
 *
 * cmd.exe / conhost / raster fonts do not: those glyphs are missing or measure
 * two columns under a CJK code page. GPU terminals on Windows (WezTerm,
 * Windows Terminal, Alacritty, Ghostty, mintty, VS Code) do, and forcing the
 * ASCII fallback there doubles the symbol — too big to scan on a typical pane.
 */
export function terminalRendersHalfBlockQR(
  env: NodeJS.Dict<string> = process.env,
) {
  // Keep in sync with `shouldRenderCompactTerminalQR` in packages/remote/src/qrcode.ts.
  // `@nikcli-ai/remote` cannot import this module (util already depends on remote).
  if (
    env.WEZTERM_EXECUTABLE ||
    env.WEZTERM_PANE ||
    env.WT_SESSION ||
    env.WT_PROFILE_ID ||
    env.ALACRITTY_SOCKET ||
    env.ALACRITTY_WINDOW_ID ||
    env.GHOSTTY_RESOURCES_DIR ||
    env.GHOSTTY_BIN_DIR ||
    env.KITTY_WINDOW_ID ||
    env.KITTY_PID ||
    env.HERDR_PANE_ID ||
    env.HERDR_ENV ||
    env.HERDR_SOCKET_PATH
  ) {
    return true;
  }
  const identity = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
  return /wezterm|alacritty|ghostty|kitty|iterm|mintty|warp|vscode|herdr/.test(
    identity,
  );
}

/**
 * Whether a QR has to be drawn with ASCII spaces instead of `█▀▄`.
 *
 * Restricted to Windows consoles that cannot be trusted with half-block
 * glyphs. WezTerm and Windows Terminal speak UTF-8 and ship a font that has
 * them, so they keep the compact renderer.
 */
export function shouldUseAsciiQR(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.Dict<string> = process.env,
) {
  return platform === "win32" && !terminalRendersHalfBlockQR(env);
}

/**
 * Turn on VT sequences and UTF-8 on stdout so a QR printed with `console.log`
 * is actually colored, not a soup of `←[40m` and `?`.
 *
 * OpenTUI does this for the TUI; `nikcli mobile pair` never starts a renderer
 * and otherwise inherits whatever code page the console happened to have.
 */
export function win32EnableVirtualTerminal() {
  if (process.platform !== "win32") return;
  if (!process.stdout.isTTY) return;
  if (!load()) return;

  const handle = k32!.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return;

  const mode = buf[0]!;
  const next =
    mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
  if (next !== mode) k32!.symbols.SetConsoleMode(handle, next);
  k32!.symbols.SetConsoleOutputCP(CP_UTF8);
}

function load() {
  if (process.platform !== "win32") return false;
  try {
    k32 ??= kernel();
    return true;
  } catch {
    return false;
  }
}

export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return;
  if (!process.stdin.isTTY) return;
  if (!load()) return;

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return;

  const mode = buf[0]!;
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
}

export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return;
  if (!process.stdin.isTTY) return;
  if (!load()) return;

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE);
  k32!.symbols.FlushConsoleInputBuffer(handle);
}

export function restoreTerminalState() {
  if (process.platform === "win32") win32FlushInputBuffer();
  process.stdout.write(TERMINAL_RESET_SEQUENCE);
}

let unhook: (() => void) | undefined;

export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return;
  if (!process.stdin.isTTY) return;
  if (!load()) return;
  if (unhook) return unhook;

  const stdin = process.stdin as any;
  const original = stdin.setRawMode;

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return;
  const initial = buf[0]!;

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return;
    const mode = buf[0]!;
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
  };

  const later = () => {
    enforce();
    setImmediate(enforce);
  };

  let wrapped: ((mode: boolean) => unknown) | undefined;

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode);
      later();
      return result;
    };

    stdin.setRawMode = wrapped;
  }

  later();

  let done = false;
  unhook = () => {
    if (done) return;
    done = true;

    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original;
    }

    k32!.symbols.SetConsoleMode(handle, initial);
    unhook = undefined;
  };

  return unhook;
}
