/*
 * The decisions behind `scripts/drive-test-app.ts`, kept apart from the
 * sockets so they can be tested without an ADE Test listening: which port
 * to knock on, which remote-debugging target is the window, and whether
 * what answers is a test build at all.
 */

import type { TestAppRecord } from "./test-app"

/** Where the port came from, for the message that says what was tried. */
export interface CdpChoice {
  port: number
  source: "CDP_PORT" | "record"
}

/**
 * The port to drive: `CDP_PORT` when set, else the one `bun run test:app --cdp`
 * wrote in the worktree's record. Nothing is guessed from the dev port, because
 * an instance started without `--cdp` has no remote debugging at all, and a
 * knock on a port nobody chose would either hang or hit somebody else's app.
 */
export function chooseCdpPort(env: string | undefined, record: TestAppRecord | undefined): CdpChoice | string {
  if (env !== undefined && env !== "") {
    const port = Number(env)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `CDP_PORT non è una porta: ${env}`
    return { port, source: "CDP_PORT" }
  }
  if (record?.cdpPort) return { port: record.cdpPort, source: "record" }
  if (record) return "ADE Test di questa worktree è partita senza --cdp: fermala e riavviala con `bun run test:app --cdp`"
  return "nessuna ADE Test registrata per questa worktree: avviala con `bun run test:app --cdp`, o passa CDP_PORT"
}

/** One row of `/json/list`, as far as picking the window needs. */
export interface CdpTarget {
  type?: string
  url?: string
  title?: string
  webSocketDebuggerUrl?: string
}

/**
 * The window among the targets. WebView2 lists the page and its workers; the
 * page is the one to talk to. Two pages would mean two windows on one port,
 * which the port scheme rules out, so the first is taken.
 */
export function pickPage(targets: unknown): CdpTarget | string {
  if (!Array.isArray(targets)) return "la risposta di /json/list non è un elenco"
  const page = targets.find(
    (target): target is CdpTarget =>
      !!target && typeof target === "object" && (target as CdpTarget).type === "page" && typeof (target as CdpTarget).webSocketDebuggerUrl === "string",
  )
  return page ?? "nessuna finestra fra i bersagli di /json/list"
}

/**
 * What the page is asked, before any command: the build mark, and whether the
 * workbench is on screen yet. Both travel in one round trip.
 */
export const BUILD_CHECK =
  '({ build: document.documentElement.dataset.adeBuild ?? null, workbench: !!document.querySelector("[data-slot=ade-bar]") })'

/** How long the page may take to declare itself before the script gives up waiting. */
export const BUILD_WAIT_MS = 15_000

export type BuildVerdict = "test" | "waiting" | "other"

/**
 * Only a test build is driven. `dev.tsx` sets `data-ade-build="test"` on the
 * document when the Tauri identifier is the test one, and nothing else does;
 * the official ADE answers `null`. The check is on the page, not on the port,
 * because the port is only a convention and the user may have opened remote
 * debugging on the official app for a reason of their own.
 *
 * The mark arrives a moment after the page, and after the workbench too:
 * `dev.tsx` asks Tauri for the identifier and sets the mark when the answer
 * comes, while the workbench renders on its own. The first version refused a
 * bare workbench at once with the message meant for the official ADE — true
 * for a few seconds only, and exactly the fear the check exists to remove.
 * So a missing mark is always waited for; once the wait is over, a workbench
 * still without it is another ADE, refused hard, and no workbench at all is a
 * window still loading, said as such.
 */
export function buildVerdict(answer: unknown, waited = false): BuildVerdict {
  const { build, workbench } = (answer && typeof answer === "object" ? answer : {}) as { build?: unknown; workbench?: unknown }
  if (build === "test") return "test"
  if (build === null || build === undefined) return waited && workbench ? "other" : "waiting"
  return "other"
}

/** The message for each refusal; the one for another ADE stays as hard as it was. */
export function buildRefusal(verdict: Exclude<BuildVerdict, "test">, answer?: unknown): string {
  if (verdict === "waiting") {
    return `sto ancora aspettando che la pagina dichiari di essere ADE Test: dopo ${BUILD_WAIT_MS / 1000} s non lo ha fatto. La finestra sta ancora caricando? Riprova fra poco`
  }
  const build = (answer && typeof answer === "object" ? (answer as { build?: unknown }).build : undefined) ?? null
  return build === null
    ? "questa finestra non è ADE Test (nessun contrassegno di build di prova): non si guida ADE ufficiale, nemmeno per sbaglio"
    : `questa finestra ha un contrassegno di build sconosciuto (${String(build)}): è un'altra ADE, non la guido`
}

/** The commands, with the argument each takes. */
export const COMMANDS = {
  panes: "elenca i pannelli (indice, titolo)",
  text: "<n>  le righe visibili del terminale del pannello n",
  notes: "<n>  le ultime righe del transcript del pannello n (note di ADE)",
  type: "<n> <testo>  digita testo nel pannello n e preme Invio",
  key: "<n> <Enter|Escape|Tab>  preme un tasto nel pannello n",
  shot: "<file.png>  salva uno screenshot della finestra",
  eval: "<js>  valuta un'espressione nella pagina e stampa il valore",
} as const

export type Command = keyof typeof COMMANDS

export interface ParsedArgs {
  command: Command
  pane?: number
  rest: string
}

/** The argument line, or what is wrong with it. */
export function parseArgs(argv: readonly string[]): ParsedArgs | string {
  const [command, ...rest] = argv
  if (!command || !(command in COMMANDS)) return usage()
  const withPane = command === "text" || command === "notes" || command === "type" || command === "key"
  if (!withPane) {
    if ((command === "shot" || command === "eval") && rest.length === 0) return `${command}: manca l'argomento`
    return { command: command as Command, rest: rest.join(" ") }
  }
  const pane = Number(rest[0])
  if (!Number.isInteger(pane) || pane < 1) return `${command}: il primo argomento è l'indice del pannello, da 1`
  const tail = rest.slice(1).join(" ")
  if ((command === "type" || command === "key") && !tail) return `${command}: manca il testo`
  return { command: command as Command, pane, rest: tail }
}

export function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, help]) => `  ${name.padEnd(6)} ${help}`)
  return `uso: bun scripts/drive-test-app.ts <comando> [argomenti]\n${lines.join("\n")}`
}

/** How long a knock on the port may take before it is called not listening. */
export const CONNECT_TIMEOUT_MS = 3000

/** The one message for a port nobody answers on, with what was tried. */
export function notListening(choice: CdpChoice, cause: string): string {
  const where = choice.source === "CDP_PORT" ? `CDP_PORT=${choice.port}` : `porta ${choice.port} dal record di questa worktree`
  return `ADE Test non risponde su 127.0.0.1:${choice.port} (${where}): ${cause}. È aperta? Va avviata con \`bun run test:app --cdp\`.`
}
