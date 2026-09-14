import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { AgentFile } from "../bots/nikcli"
import { listBots, resolveRoots } from "../bots/store"
import "./sections.css"

/**
 * ADE's own screens inside the settings panel.
 *
 * The panel itself is `VoiceSettingsPanel`, which owns the shell, the rail
 * and the modal chrome. It began as the voice panel and grew a slot for the
 * host's screens; these are those screens. The voice sections keep their own
 * heading in the rail, so "Voce" reads as one part of the list rather than
 * as the list with six strangers appended.
 *
 * Two of these are real and four are not yet, and the ones that are not say
 * so in as many words. A settings screen that shows plausible-looking
 * controls doing nothing is worse than an empty one: the user changes a
 * setting, nothing happens, and they have no way to tell whether the feature
 * is broken or absent.
 */

/**
 * A section whose feature does not exist yet.
 *
 * Kept deliberately plain — no disabled toggles, no greyed-out fields. It
 * names what belongs here and where the nearest working thing is, and that
 * is the whole content.
 */
export function NotBuiltYet(props: { title: string; what: string; instead?: string }) {
  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {props.title}
        </h3>
        <p data-slot="section-desc">{props.what}</p>
      </div>
      <p data-slot="settings-empty">
        Non c'è ancora niente da configurare qui: la sezione esiste, la funzione no.
        <Show when={props.instead}>{(instead) => <> {instead()}</>}</Show>
      </p>
    </>
  )
}

/** Automations: a thing ADE runs on its own, on a schedule or on an event. */
export function RoutineSection() {
  return (
    <NotBuiltYet
      title="Routine"
      what="Cose che ADE fa da sé: a un orario, all'apertura di un progetto, o quando una sessione finisce."
      instead="Per ora una sessione si avvia a mano, dalla schermata di lancio."
    />
  )
}

export interface BotSectionProps {
  /** The open project, so project bots are listed as well as global ones. */
  projectRoot?: string
}

/**
 * The bots, as configuration rather than as a place to talk to them.
 *
 * Read-only on purpose, and read from the same place nikcli reads: a bot is an
 * agent file under `.nikcli/agent/` or in nikcli's global configuration, so
 * this is a view of that directory rather than of a roster ADE keeps. They are
 * created and edited in the Bot view.
 */
export function BotSection(props: BotSectionProps) {
  const [roster, setRoster] = createSignal<AgentFile[]>([])
  const [ready, setReady] = createSignal(false)

  /*
   * Read once, when the section mounts.
   *
   * Two directories and a file read each, which is not something to repeat on
   * every unrelated redraw — and the panel is opened fresh each time, so once
   * is also current.
   */
  onMount(() => {
    void resolveRoots(props.projectRoot)
      .then(listBots)
      .then(setRoster)
      .finally(() => setReady(true))
  })

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Bot
        </h3>
        <p data-slot="section-desc">
          Gli agenti di nikcli che questa macchina conosce: con quale modello girano, e se
          appartengono al progetto o a tutti. Si creano e si modificano nella vista Bot.
        </p>
      </div>

      <Show
        when={roster().length > 0}
        fallback={
          <p data-slot="settings-empty">
            {ready()
              ? "Nessun agente nikcli. Se ne crea uno dalla vista Bot."
              : "Lettura delle cartelle di nikcli…"}
          </p>
        }
      >
        <ul data-slot="settings-list">
          <For each={roster()}>
            {(bot) => (
              <li data-slot="settings-row">
                <span data-slot="settings-glyph" aria-hidden="true">
                  {bot.identifier.slice(0, 1).toUpperCase()}
                </span>
                <span data-slot="settings-name">{bot.identifier}</span>
                <span data-slot="settings-meta">{bot.model ?? "modello di nikcli"}</span>
                <span data-slot="settings-meta">
                  {bot.scope === "project" ? "progetto" : "globale"}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

export interface SkillsSectionProps {
  projectRoot?: string
}

/**
 * The tools the bots are allowed, seen from the side of who uses them.
 *
 * nikcli's agents do not carry "skills"; they carry a tool list, and what a
 * file records is the tools that have been switched *off*. So the honest
 * reading is per-bot: which ones each has given up. A catalogue of everything
 * nikcli can do belongs to nikcli, and inventing one here would be a list ADE
 * cannot keep in step.
 */
export function SkillsSection(props: SkillsSectionProps) {
  const [roster, setRoster] = createSignal<AgentFile[]>([])
  onMount(() => {
    void resolveRoots(props.projectRoot).then(listBots).then(setRoster)
  })

  const restricted = createMemo(() => roster().filter((bot) => bot.disabledTools.length > 0))

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Strumenti
        </h3>
        <p data-slot="section-desc">
          Quali strumenti sono stati tolti a un bot. Chi non compare qui li ha tutti: nikcli
          registra nel file solo le rinunce.
        </p>
      </div>

      <Show
        when={restricted().length > 0}
        fallback={
          <p data-slot="settings-empty">
            Nessun bot ha limitazioni: tutti possono usare ogni strumento di nikcli.
          </p>
        }
      >
        <ul data-slot="settings-list">
          <For each={restricted()}>
            {(bot) => (
              <li data-slot="settings-row">
                <span data-slot="settings-name">{bot.identifier}</span>
                <span data-slot="settings-meta">senza {bot.disabledTools.join(", ")}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

/** The pinned column count, and `undefined` for "let the grid decide". */
export const GRID_COLUMN_CHOICES: readonly (number | undefined)[] = [undefined, 1, 2, 3, 4]

export interface GridSectionProps {
  /** What the workbench has pinned, or `undefined` for automatic. */
  columns: number | undefined
  onChange: (columns: number | undefined) => void
}

/**
 * How the session grid is laid out.
 *
 * This used to be five chips on the right of the top bar, shown only in the
 * `code` view. It is configuration — a thing set once and then left alone —
 * and the bar is where the verbs live, so it kept a permanent seat beside
 * them for a decision nobody makes twice a session. Here it costs nothing
 * when it is not wanted, and it says what "auto" actually does, which five
 * chips in a toolbar had no room to.
 */
export function GridSection(props: GridSectionProps) {
  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Griglia
        </h3>
        <p data-slot="section-desc">
          Su quante colonne stanno i pannelli nella vista Codice. In automatico ADE le sceglie
          dalla larghezza della finestra e da quanti pannelli sono aperti, in modo che nessuno
          scenda sotto la larghezza minima leggibile.
        </p>
      </div>

      <div data-slot="settings-choices" role="group" aria-label="Colonne della griglia">
        <For each={GRID_COLUMN_CHOICES}>
          {(value) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-active={props.columns === value ? "true" : undefined}
              aria-pressed={props.columns === value}
              onClick={() => props.onChange(value)}
            >
              {value === undefined ? "Auto" : value}
            </button>
          )}
        </For>
      </div>
    </>
  )
}

/** Servers ADE would speak the Model Context Protocol to. */
export function McpSection() {
  return (
    <NotBuiltYet
      title="MCP"
      what="I server a cui ADE si collega col Model Context Protocol, e quali strumenti espongono."
      instead="Le CLI agente che ADE avvia usano intanto la propria configurazione MCP, quella che userebbero da un terminale."
    />
  )
}
