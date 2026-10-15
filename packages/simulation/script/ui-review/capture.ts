// Drives the real ragu TUI headless through every screen the UI review needs and
// photographs each one at several widths. One run = one theme and one mode.
//
//   bun script/ui-review/capture.ts <out-dir> <work-dir> [dark|light] [theme] [widths]
//
// Each shot writes <mode>-<theme>-<screen>-<cols>.png and, with RAGU_DRIVE_SPANS,
// the .spans.json that html.ts turns into a coloured HTML page. No real model:
// every exchange is answered here through the simulation backend.
import { cp, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { connect } from "../../src/driver"
import type { SimulationProtocol } from "../../src/protocol"

const [outArg, workArg, mode = "dark", theme = "ragu", widthArg = "80,100,140"] = process.argv.slice(2)
if (!outArg || !workArg) throw new Error("usage: capture.ts <out-dir> <work-dir> [dark|light] [theme] [widths]")
const OUT = resolve(outArg)
const WORK = resolve(workArg)
const WIDTHS = widthArg.split(",").map(Number)
const ROWS = 40
const ragu = resolve(import.meta.dir, "../../../ragu")
const tag = `${mode}-${theme}`

const freePort = () =>
  new Promise<number>((ok, ko) => {
    const probe = createServer()
    probe.once("error", ko)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as { port: number }
      probe.close(() => ok(address.port))
    })
  })

const home = join(WORK, "home")
const project = join(WORK, "project")
const registry = join(WORK, "registry")
const tmp = join(WORK, "tmp")
await Promise.all([home, project, registry, tmp, OUT, join(home, "state"), join(project, "src")].map((d) => mkdir(d, { recursive: true })))
await writeFile(join(home, "state", "kv.json"), JSON.stringify({ theme_mode: mode, theme }))
await writeFile(
  join(project, "src", "app.ts"),
  [
    'import { greet } from "./util"',
    "",
    "export function main(name: string) {",
    "  const message = greet(name)",
    "  console.log(message)",
    "  return message",
    "}",
    "",
  ].join("\n"),
)
await writeFile(join(project, "src", "util.ts"), 'export const greet = (name: string) => `Hello, ${name}`\n')
await writeFile(join(project, "README.md"), "# demo\n\nA tiny project for the UI review.\n")
await cp(resolve(import.meta.dir, "../../test/fixtures/basic.png"), join(project, "schermata.png"))

const [uiPort, backendPort, openaiPort] = await Promise.all([freePort(), freePort(), freePort()])
await writeFile(
  join(registry, "review.json"),
  JSON.stringify({
    endpoints: {
      ui: `ws://127.0.0.1:${uiPort}`,
      backend: `ws://127.0.0.1:${backendPort}`,
      openai: `http://127.0.0.1:${openaiPort}`,
    },
    viewport: { cols: WIDTHS.at(-1), rows: ROWS },
  }),
)

const config = {
  autoupdate: false,
  theme,
  // One command asks, so the permission dialog can be photographed; the rest runs.
  permission: { bash: { "*": "allow", "rm *": "ask" }, edit: "allow", external_directory: "allow" },
}
const child = Bun.spawn(
  [process.execPath, "run", "--conditions=browser", "./src/index.ts", project, "--model", "simulation/deterministic"],
  {
    cwd: ragu,
    env: {
      ...process.env,
      TMP: tmp,
      TEMP: tmp,
      RAGU_DRIVE: "review",
      RAGU_DRIVE_REGISTRY_DIR: registry,
      RAGU_DRIVE_RENDERER: "headless",
      RAGU_DRIVE_MEDIA_DIR: OUT,
      RAGU_DRIVE_SPANS: "1",
      RAGU_TEST_HOME: home,
      RAGU_CONFIG_CONTENT: JSON.stringify(config),
      RAGU_DISABLE_PROJECT_CONFIG: "1",
      RAGU_DISABLE_DEFAULT_PLUGINS: "1",
      RAGU_DISABLE_EDITOR_CONTEXT: "1",
      RAGU_DISABLE_LSP_DOWNLOAD: "1",
      RAGU_DISABLE_AUTOUPDATE: "1",
      XDG_DATA_HOME: join(WORK, "xdg-data"),
      XDG_CACHE_HOME: join(WORK, "xdg-cache"),
      XDG_CONFIG_HOME: join(WORK, "xdg-config"),
      XDG_STATE_HOME: join(WORK, "xdg-state"),
    },
    stdin: "ignore",
    // Files, not pipes: a shell a tool started can outlive the CLI and keep a
    // pipe open, and reading it to the end would then never return.
    stdout: Bun.file(join(OUT, `${tag}-exit-stdout.txt`)),
    stderr: Bun.file(join(OUT, `${tag}-stderr.txt`)),
  },
)
const deadline = setTimeout(() => child.kill(9), 20 * 60_000)

const log: string[] = []
const note = (line: string) => {
  log.push(line)
  console.log(`[${tag}] ${line}`)
}

type Item = SimulationProtocol.Backend.Item
type Script = { items?: Item[]; reason?: string; disconnect?: boolean }
const script: Script[] = []
let answered = 0
let stopped = false

const text = (value: string): Item => ({ type: "textDelta", text: value })
const reasoning = (value: string): Item => ({ type: "reasoningDelta", text: value })
let callIndex = 0
const call = (name: string, input: unknown): Item => ({
  type: "toolCall",
  index: callIndex,
  id: `call_${++callIndex}`,
  name,
  input,
})

try {
  const [ui, backend] = await Promise.all([
    connect(`ws://127.0.0.1:${uiPort}`, { timeoutMs: 180_000 }),
    connect(`ws://127.0.0.1:${backendPort}`, { timeoutMs: 180_000 }),
  ])
  await backend.call("llm.attach")

  // Every exchange the CLI opens: the chat turns take the next scripted reply,
  // titles and summaries get a constant line. One long wait at a time: the
  // driver keeps a timed-out waiter, and it would swallow the next request.
  const responder = (async () => {
    while (!stopped) {
      const exchange = await backend
        .next<SimulationProtocol.Backend.OpenedExchange>("llm.request", 60 * 60_000)
        .catch(() => undefined)
      if (!exchange) continue
      answered++
      const body = exchange.body as { tools?: unknown[]; messages?: unknown } | null
      const chat = Array.isArray(body?.tools) && body.tools.length > 0
      if (!chat) {
        const summary = JSON.stringify(body ?? "").includes("summar")
        await backend.call("llm.chunk", {
          id: exchange.id,
          items: [
            text(summary ? "Riassunto: il progetto demo, letto e modificato in src/app.ts." : "Revisione UI"),
            { type: "raw", chunk: { choices: [], usage: { prompt_tokens: 300, completion_tokens: 12, total_tokens: 312 } } },
          ],
        })
        await backend.call("llm.finish", { id: exchange.id, reason: "stop" })
        continue
      }
      const next = script.shift() ?? { items: [text("Fatto.")] }
      if (next.disconnect) {
        await backend.call("llm.disconnect", { id: exchange.id })
        continue
      }
      // Tool calls are indexed per message; the usage chunk is what a real
      // provider sends last (the simulation sends none, and the turn then
      // ends on a TypeError from Session.getUsage).
      let position = 0
      const items: Item[] = [
        ...(next.items ?? []).map((item) => (item.type === "toolCall" ? { ...item, index: position++ } : item)),
        { type: "raw", chunk: { choices: [], usage: { prompt_tokens: 1840, completion_tokens: 212, total_tokens: 2052 } } },
      ]
      await backend.call("llm.chunk", { id: exchange.id, items })
      const reason = next.reason ?? (items.some((item) => item.type === "toolCall") ? "tool-calls" : "stop")
      await backend.call("llm.finish", { id: exchange.id, reason })
    }
  })()

  const screen = async () => (await ui.call<SimulationProtocol.Frontend.State>("ui.state")).screen
  const waitFor = async (pattern: RegExp, ms = 15_000) => {
    const start = Date.now()
    let last = ""
    while (Date.now() - start < ms) {
      last = await screen()
      if (pattern.test(last)) return true
      await Bun.sleep(80)
    }
    return false
  }
  // Settled: no interrupt hint and the same frame twice, 600 ms apart.
  const settle = async (ms = 30_000) => {
    const start = Date.now()
    let previous = ""
    while (Date.now() - start < ms) {
      const now = await screen()
      if (!/esc (interrompi|interrupt)/i.test(now) && now === previous) return true
      previous = now
      await Bun.sleep(600)
    }
    return false
  }
  const press = (key: string, modifiers?: Record<string, boolean>) => ui.call("ui.press", { key, modifiers })
  const leader = async (key: string) => {
    await press("x", { ctrl: true })
    await Bun.sleep(120)
    await press(key)
    await Bun.sleep(500)
  }
  const type = async (value: string) => {
    await ui.call("ui.type", { text: value })
    await Bun.sleep(250)
  }
  const escape = async (times = 1) => {
    for (let i = 0; i < times; i++) {
      await press("ESCAPE")
      await Bun.sleep(350)
    }
  }
  let current = WIDTHS.at(-1)!
  const resize = async (cols: number) => {
    if (cols === current) return
    await ui.call("ui.resize", { cols, rows: ROWS })
    current = cols
    await Bun.sleep(350)
  }
  const shots: string[] = []
  const shot = async (name: string, widths = WIDTHS) => {
    for (const cols of widths) {
      await resize(cols)
      await ui.call("ui.screenshot", { name: `${tag}-${name}-${cols}` })
      await writeFile(join(OUT, `${tag}-${name}-${cols}.txt`), await screen())
    }
    await resize(WIDTHS.at(-1)!)
    shots.push(name)
    note(`shot ${name}`)
  }
  const turn = async (prompt: string, ...replies: Script[]) => {
    script.push(...replies)
    await type(prompt)
    await press("RETURN")
    await Bun.sleep(400)
    const done = await settle()
    note(`turn «${prompt}»: ${done ? "settled" : "NOT settled"}`)
  }

  note(`boot: ${(await waitFor(/Chiedi qualsiasi cosa|Ask anything/, 180_000)) ? "ok" : "NO"}`)
  await Bun.sleep(1500)
  await shot("01-home")

  // Prompt: slash menu, @ mentions, a chip.
  await type("/")
  await Bun.sleep(400)
  await shot("02-prompt-slash")
  await escape()
  await press("BACKSPACE")
  await type("guarda @src")
  await Bun.sleep(600)
  await shot("03-prompt-mention")
  await press("RETURN")
  await Bun.sleep(400)
  await type(" e @schermata")
  await Bun.sleep(600)
  await press("RETURN")
  await Bun.sleep(400)
  await shot("04-prompt-chips")
  // Clear the draft: ctrl+u twice covers a two-line draft.
  for (let i = 0; i < 6; i++) await press("u", { ctrl: true })
  await Bun.sleep(300)

  // Transcript: markdown, reasoning, code.
  await turn("spiegami il progetto", {
    items: [
      reasoning(
        "L'utente vuole una panoramica. Guardo la struttura: src/app.ts chiama greet da src/util.ts.\nNon serve leggere altro per una prima risposta.",
      ),
      text(
        [
          "## Il progetto",
          "",
          "Un esempio **minimo** con due file in `src/`:",
          "",
          "- `app.ts` espone `main(name)`;",
          "- `util.ts` contiene `greet`;",
          "  - annidato: nessuna dipendenza esterna.",
          "",
          "1. Avvio",
          "2. Saluto",
          "",
          "> Nota: non ci sono test.",
          "",
          "| file | righe |",
          "|---|---|",
          "| src/app.ts | 7 |",
          "| src/util.ts | 1 |",
          "",
          "```ts",
          "export function main(name: string) {",
          "  return greet(name) // saluta",
          "}",
          "```",
          "",
          "Vedi [la guida](https://example.com/guida) per i dettagli.",
        ].join("\n"),
      ),
    ],
  })
  await shot("05-transcript-markdown")

  // Read-only tools.
  await turn(
    "leggi e cerca",
    {
      items: [
        text("Leggo i file."),
        call("read", { filePath: join(project, "src", "app.ts") }),
        // The edit turn needs both files read first, or edit refuses.
        call("read", { filePath: join(project, "src", "util.ts") }),
        call("grep", { pattern: "greet", path: project }),
        call("glob", { pattern: "**/*.ts", path: project }),
        call("list", { path: project }),
      ],
    },
    { items: [text("Ho letto `src/app.ts` e trovato 2 usi di `greet`.")] },
  )
  await shot("06-tools-read")

  // Editing tools with diffs.
  await turn(
    "modifica il saluto",
    {
      items: [
        call("edit", {
          filePath: join(project, "src", "util.ts"),
          oldString: "`Hello, ${name}`",
          newString: "`Ciao, ${name}!`",
        }),
        call("write", {
          filePath: join(project, "src", "nuovo.ts"),
          content: 'export const versione = "1.0.0"\nexport const nome = "demo"\n',
        }),
        // apply_patch is not offered to this model; a second edit shows a multi-line diff.
        call("edit", {
          filePath: join(project, "src", "app.ts"),
          oldString: "  const message = greet(name)\n  console.log(message)",
          newString: "  const message = greet(name.trim())\n  if (!message) throw new Error(\"vuoto\")\n  console.info(message)",
        }),
      ],
    },
    { items: [text("Ho cambiato il saluto e creato `src/nuovo.ts`.")] },
  )
  await shot("07-tools-edit")

  // Shell: success, failure, and a tool error.
  await turn(
    "esegui i comandi",
    {
      items: [
        call("bash", { command: "git --version", description: "Versione di git" }),
        call("bash", { command: "git status", description: "Stato del repo" }),
        call("read", { filePath: join(project, "manca.ts") }),
      ],
    },
    { items: [text("Il progetto non è un repository git, e `manca.ts` non esiste.")] },
  )
  await shot("08-tools-bash-errors")

  // Todo list and a foreground subagent.
  await turn(
    "pianifica e delega",
    {
      items: [
        call("todowrite", {
          todos: [
            { id: "1", content: "Leggere il progetto", status: "completed", priority: "high" },
            { id: "2", content: "Cambiare il saluto", status: "in_progress", priority: "high" },
            { id: "3", content: "Scrivere i test", status: "pending", priority: "medium" },
            { id: "4", content: "Vecchia idea", status: "cancelled", priority: "low" },
          ],
        }),
        call("task", {
          description: "Cerca i test",
          prompt: "Trova i file di test del progetto",
          subagent_type: "explore",
          background: false,
        }),
      ],
    },
    { items: [text("Nessun file di test trovato.")] },
    { items: [text("Il subagent non ha trovato test: li scrivo io.")] },
  )
  await shot("09-todo-subagent")

  // An image in the reply text.
  await turn("mostrami la schermata", {
    items: [text(`Ecco la schermata: "${join(project, "schermata.png")}"\n\nÈ l'immagine del test.`)],
  })
  await Bun.sleep(1500)
  await shot("10-image-inline")

  // A turn the provider drops: the error row.
  // A dropped connection is retried and ends well; a provider error in the
  // stream is what reaches the user as the turn's error row.
  await turn("prova un errore", {
    items: [
      text("Comincio a"),
      { type: "raw", chunk: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } },
    ],
  })
  await Bun.sleep(1000)
  await shot("11-turn-error")

  // Permission dialog.
  script.push(
    { items: [call("bash", { command: "rm -rf dist", description: "Rimuove la build" })] },
    { items: [text("Cartella `dist` rimossa.")] },
  )
  await type("pulisci la build")
  await press("RETURN")
  note(`permission: ${(await waitFor(/rm -rf dist[\s\S]*(Allow|Consenti|Permetti)/i, 20_000)) ? "shown" : "NOT shown"}`)
  await Bun.sleep(500)
  await shot("12-permission")
  await press("RETURN")
  await settle()

  // Question tool.
  script.push(
    {
      items: [
        call("question", {
          questions: [
            {
              question: "Quale stile di saluto preferisci per l'app?",
              header: "Saluto",
              options: [
                { label: "Formale", description: "Buongiorno, nome" },
                { label: "Informale", description: "Ciao, nome!" },
                { label: "Nessuno", description: "Solo il nome" },
              ],
            },
          ],
        }),
      ],
    },
    { items: [text("Uso il saluto scelto.")] },
  )
  await type("chiedimi lo stile")
  await press("RETURN")
  note(`question: ${(await waitFor(/Quale stile di saluto/, 20_000)) ? "shown" : "NOT shown"}`)
  await Bun.sleep(500)
  await shot("13-question")
  await press("RETURN")
  await Bun.sleep(500)
  await settle(10_000)
  if (/Quale stile di saluto/.test(await screen())) {
    await press("RETURN")
    await settle(10_000)
  }
  await shot("14-transcript-after")

  // Dialogs.
  const dialog = async (name: string, open: () => Promise<void>, ready: RegExp) => {
    await open()
    const shown = await waitFor(ready, 6000)
    note(`${name}: ${shown ? "open" : "NOT open"}`)
    await Bun.sleep(400)
    await shot(name)
    await escape()
    if (ready.test(await screen())) await escape()
  }
  await dialog("15-palette", () => press("p", { ctrl: true }), /Comandi|Commands/)
  await dialog("16-help", async () => { await type("/help"); await press("RETURN") }, /Scorciatoie|Shortcuts/)
  await dialog("17-models", () => leader("m"), /Modell|Models|Select model/i)
  await dialog("18-agents", () => leader("a"), /Agent/i)
  await dialog("19-themes", () => leader("t"), /Tem|Theme/i)
  await dialog("20-sessions", () => leader("l"), /Sessioni|Sessions/)
  await dialog("21-timeline", () => leader("g"), /Timeline|Cronologia/)
  await dialog("22-status", () => leader("s"), /Stato|Status/)

  // Sidebar, toggled where it fits.
  await leader("b")
  await Bun.sleep(600)
  await shot("23-sidebar")
  await leader("b")

  // Toasts: a configuration reload shows two.
  await press("p", { ctrl: true })
  await waitFor(/Comandi|Commands/, 4000)
  await type("Reload")
  await Bun.sleep(500)
  await press("RETURN")
  await Bun.sleep(700)
  await shot("24-toast", [WIDTHS.at(-1)!])

  // Compaction.
  await leader("c")
  await settle(30_000)
  await Bun.sleep(800)
  await shot("25-compaction")

  // Narrow pane, the ADE case.
  await shot("26-narrow-60", [60])
  // The sidebar toggled by hand, then the pane narrows: does it give way?
  await leader("b")
  await Bun.sleep(600)
  await shot("27-sidebar-toggled", [140, 60])

  // Exit: the summary lands on stdout after the renderer is gone.
  await press("c", { ctrl: true })
  await Bun.sleep(400)
  await press("c", { ctrl: true })
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
  note(`exit: ${exited ? "clean" : "had to kill"}`)
  stopped = true
  void responder // parked on a long wait; the process ends without it
  ui.close()
  backend.close()
  note(`shots ${shots.length}, model exchanges ${answered}, unused script ${script.length}`)
} catch (error) {
  note(`ERROR ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  stopped = true
  clearTimeout(deadline)
  child.kill(9)
  await child.exited
  await writeFile(join(OUT, `${tag}-log.txt`), log.join("\n") + "\n")
}
// The responder is parked on an hour-long wait; its timer must not keep the run alive.
process.exit(0)
