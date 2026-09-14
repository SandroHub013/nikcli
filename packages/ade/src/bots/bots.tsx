/**
 * The bot section: the agents nikcli can run, made and started from here.
 *
 * A bot used to be ADE's own idea — a name, a model and a persona in
 * `localStorage`, with nothing behind it that could actually run. nikcli
 * already has that object and can execute it: an *agent*, a markdown file with
 * frontmatter and a system prompt, discovered under `.nikcli/agent/` in the
 * project or in nikcli's global configuration, created by `nikcli agent
 * create` and started with `nikcli --agent <name>`. So the section is now a
 * view onto those files rather than a second list that disagrees with them:
 * what is made here appears in `nikcli agent list`, what is edited there
 * appears here, and "Avvia" opens the same session the user would open in a
 * terminal.
 *
 * (`nikcli bot` is a different thing wearing the same word — it manages chat
 * platform connectors, Discord and Slack. The native creation function for a
 * bot in this sense is `agent create`.)
 *
 * Everything with a rule in it is in the sibling `.ts` files — `nikcli.ts` for
 * the argument lists and the file format, `store.ts` for reading and writing
 * them, `room.ts` for who speaks when several are in one conversation. A
 * `.tsx` cannot be imported under `bun test` here, so nothing that matters
 * lives in this file.
 */

import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js"
import { COMMON_EFFORTS, OBJECTIVES_HEADING, splitPrompt, type AgentFile, type AgentScope } from "./nikcli"
import {
  createBot,
  deleteBot,
  listBots,
  listModels,
  resolveRoots,
  updateBot,
  type BotRoots,
} from "./store"
import "./bots.css"

export interface BotsProps {
  /** The open project, when there is one. Decides whether project bots exist. */
  projectRoot?: string
  /** Opens a session running this bot. Absent in the browser harness. */
  onLaunch?: (bot: AgentFile) => void
  /** Opens the bot's own file in the editor. */
  onOpenFile?: (path: string) => void
}

export function Bots(props: BotsProps) {
  const [roots, setRoots] = createSignal<BotRoots>({})
  const [openId, setOpenId] = createSignal<string>()
  const [composing, setComposing] = createSignal(false)
  const [reloads, setReloads] = createSignal(0)

  onMount(() => {
    void resolveRoots(props.projectRoot).then(setRoots)
  })

  /*
   * The roster is the directory, re-read rather than remembered.
   *
   * A bot is a file the user can open in the editor two panes away, and nikcli
   * itself writes to the same place — a list held in memory would be a second
   * opinion about what exists. `reloads` is the handle for "something changed,
   * look again".
   */
  const [roster, { refetch }] = createResource(
    () => ({ roots: roots(), tick: reloads() }),
    (source) => listBots(source.roots),
  )

  /* Asked of nikcli, once. These are the models a bot can be pinned to, and
     they are not the same set the chat section offers. */
  const [models] = createResource(
    () => props.projectRoot ?? "",
    (cwd) => listModels(cwd || undefined),
  )

  const current = () => (roster() ?? []).find((bot) => bot.path === openId())

  const reload = () => setReloads((n) => n + 1)

  return (
    <section data-component="ade-bots">
      <aside data-slot="bots-roster">
        <header data-slot="bots-roster-head">
          <span data-slot="bots-roster-title">bot</span>
          <button
            type="button"
            data-slot="bots-new"
            onClick={() => {
              setComposing(true)
              setOpenId(undefined)
            }}
            aria-label="Nuovo bot"
            title="Nuovo bot"
          >
            +
          </button>
        </header>

        <Show
          when={(roster() ?? []).length > 0}
          fallback={
            <p data-slot="bots-roster-empty">
              <Show when={!roster.loading} fallback={<>Lettura…</>}>
                Nessun agente nikcli. Creane uno.
              </Show>
            </p>
          }
        >
          <For each={roster() ?? []}>
            {(bot) => (
              <button
                type="button"
                data-slot="bots-row"
                data-active={bot.path === openId() ? "true" : undefined}
                onClick={() => {
                  setOpenId(bot.path)
                  setComposing(false)
                }}
              >
                <span data-slot="bots-glyph" aria-hidden="true">
                  {bot.identifier.slice(0, 1).toUpperCase()}
                </span>
                <span data-slot="bots-row-text">
                  <span data-slot="bots-row-name">{bot.identifier}</span>
                  <span data-slot="bots-row-model">
                    {bot.model ?? "modello di nikcli"} · {bot.scope === "project" ? "progetto" : "globale"}
                  </span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </aside>

      <div data-slot="bots-main">
        <Show when={composing()}>
          <BotForm
            roots={roots()}
            models={models() ?? []}
            hasProject={Boolean(props.projectRoot)}
            onCreated={(path) => {
              setComposing(false)
              setOpenId(path)
              reload()
              void refetch()
            }}
            onCancel={() => setComposing(false)}
          />
        </Show>

        <Show when={!composing() && current()}>
          {(bot) => (
            <BotDetail
              bot={bot()}
              models={models() ?? []}
              {...(props.onLaunch ? { onLaunch: props.onLaunch } : {})}
              {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
              onChanged={() => {
                reload()
                void refetch()
              }}
              onDeleted={() => {
                setOpenId(undefined)
                reload()
                void refetch()
              }}
            />
          )}
        </Show>

        <Show when={!composing() && !current() && (roster() ?? []).length > 0}>
          <p data-slot="bots-blank">Scegli un bot a sinistra, o creane un altro.</p>
        </Show>
      </div>
    </section>
  )
}

/**
 * The form.
 *
 * Two ways to make a bot, and the difference is one field. Leave the persona
 * empty and nikcli's own model writes it from the description — that is
 * `nikcli agent create`, the native route, and it also chooses the identifier
 * and the "when to use" line. Write a persona and the file is written
 * directly, byte-compatible with the generated one, because paying a model to
 * produce a prompt that is about to be thrown away is not a feature.
 *
 * The model list comes from nikcli, and "predefinito" is a real answer: a bot
 * with no `model` key runs on whatever nikcli is configured for, which is the
 * right default for someone who has not thought about it.
 */
function BotForm(props: {
  roots: BotRoots
  models: readonly string[]
  hasProject: boolean
  onCreated: (path: string) => void
  onCancel: () => void
}) {
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<AgentScope>(props.hasProject ? "project" : "global")
  const [description, setDescription] = createSignal("")
  const [persona, setPersona] = createSignal("")
  const [model, setModel] = createSignal("")
  const [effort, setEffort] = createSignal("")
  const [objectives, setObjectives] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  let nameField: HTMLInputElement | undefined
  onMount(() => nameField?.focus())

  const generating = () => persona().trim().length === 0

  const submit = async (event: Event) => {
    event.preventDefault()
    if (busy()) return

    if (description().trim().length === 0) {
      setProblem("Serve una descrizione: è quello che nikcli usa per decidere quando chiamarlo.")
      return
    }
    if (!generating() && name().trim().length === 0) {
      setProblem("Serve un nome: diventa l'identificativo del file.")
      return
    }

    setProblem(undefined)
    setBusy(true)
    const result = await createBot(
      {
        name: name(),
        scope: scope(),
        description: description().trim(),
        ...(generating() ? {} : { persona: persona() }),
        ...(model() ? { model: model() } : {}),
        ...(model() && effort().trim() ? { effort: effort().trim() } : {}),
        objectives: objectives()
          .split("\n")
          .map((line) => line.replace(/^[-*•]\s*/, "").trim())
          .filter((line) => line.length > 0),
      },
      props.roots,
    )
    setBusy(false)

    if (!result.ok) {
      setProblem(result.problem)
      return
    }
    props.onCreated(result.path)
  }

  return (
    <form data-slot="bots-form" onSubmit={(e) => void submit(e)}>
      <h2 data-slot="bots-form-title">Nuovo bot</h2>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Nome</span>
        <input
          ref={(el) => (nameField = el)}
          data-slot="bots-input"
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder="Revisore"
        />
        <span data-slot="bots-hint">
          {/* Said plainly, because the two routes name the bot differently and
              a field that is sometimes ignored is worse than one that says so. */}
          {generating()
            ? "Con la persona vuota è nikcli a scegliere l'identificativo: questo nome è solo un promemoria."
            : "Diventa il nome del file e l'identificativo passato a --agent."}
        </span>
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Dove</span>
        <select
          data-slot="bots-input"
          value={scope()}
          onChange={(event) => setScope(event.currentTarget.value === "project" ? "project" : "global")}
        >
          <option value="project" disabled={!props.hasProject}>
            Nel progetto (.nikcli/agent)
          </option>
          <option value="global">Globale (per tutti i progetti)</option>
        </select>
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Quando usarlo</span>
        <input
          data-slot="bots-input"
          value={description()}
          onInput={(event) => {
            setDescription(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder="Revisiona le pull request e segnala i rischi"
        />
      </label>

      <div data-slot="bots-row-fields">
        <label data-slot="bots-field">
          <span data-slot="bots-label">Modello</span>
          <select
            data-slot="bots-input"
            value={model()}
            onChange={(event) => setModel(event.currentTarget.value)}
          >
            <option value="">Predefinito di nikcli</option>
            <For each={props.models}>{(id) => <option value={id}>{id}</option>}</For>
          </select>
          <Show when={props.models.length === 0}>
            <span data-slot="bots-hint">
              Elenco dei modelli non disponibile: serve nikcli nel PATH. Il bot userà il modello
              predefinito.
            </span>
          </Show>
        </label>

        <label data-slot="bots-field">
          <span data-slot="bots-label">Sforzo</span>
          <input
            data-slot="bots-input"
            list="bots-efforts-new"
            value={effort()}
            placeholder="predefinito"
            onInput={(event) => setEffort(event.currentTarget.value)}
          />
          <datalist id="bots-efforts-new">
            <For each={COMMON_EFFORTS}>{(value) => <option value={value} />}</For>
          </datalist>
        </label>
      </div>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Obiettivi</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="3"
          value={objectives()}
          placeholder="Uno per riga. Restano veri in ogni conversazione."
          onInput={(event) => setObjectives(event.currentTarget.value)}
        />
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Persona</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="6"
          value={persona()}
          onInput={(event) => setPersona(event.currentTarget.value)}
          placeholder="Lascia vuoto e la scrive nikcli dalla descrizione. Oppure scrivila tu: come deve comportarsi, e cosa non deve fare."
        />
      </label>

      <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <div data-slot="bots-form-actions">
        <button type="button" data-slot="bots-btn" onClick={() => props.onCancel()} disabled={busy()}>
          Annulla
        </button>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy()}>
          {busy() ? "Creazione…" : generating() ? "Genera con nikcli" : "Crea"}
        </button>
      </div>
      <Show when={busy() && generating()}>
        {/* The generation is a model call: several seconds with nothing on
            screen reads as a button that did nothing. */}
        <p data-slot="bots-hint">nikcli sta scrivendo l'agente. Ci vuole qualche secondo.</p>
      </Show>
    </form>
  )
}

function BotDetail(props: {
  bot: AgentFile
  models: readonly string[]
  onLaunch?: (bot: AgentFile) => void
  onOpenFile?: (path: string) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  const remove = async () => {
    const failure = await deleteBot(props.bot)
    if (failure) {
      setProblem(failure)
      setConfirming(false)
      return
    }
    props.onDeleted()
  }

  return (
    <div data-slot="bots-detail">
      <header data-slot="bots-detail-head">
        <span data-slot="bots-glyph" data-large="true" aria-hidden="true">
          {props.bot.identifier.slice(0, 1).toUpperCase()}
        </span>
        <span data-slot="bots-detail-text">
          <h2 data-slot="bots-detail-name">{props.bot.identifier}</h2>
          <span data-slot="bots-detail-model">
            {props.bot.model ?? "modello predefinito di nikcli"}
            {props.bot.effort ? ` · ${props.bot.effort}` : ""} · {props.bot.mode}
          </span>
        </span>

        <Show when={props.onLaunch}>
          {(launch) => (
            <button
              type="button"
              data-slot="bots-btn"
              disabled={props.bot.mode === "subagent"}
              onClick={() => launch()(props.bot)}
              title={
                props.bot.mode === "subagent"
                  ? "Un subagente non si avvia da solo: lo chiama un altro agente"
                  : "Apre una sessione in un pannello, come da terminale"
              }
            >
              Terminale
            </button>
          )}
        </Show>

        <Show
          when={confirming()}
          fallback={
            <button type="button" data-slot="bots-btn" onClick={() => setConfirming(true)}>
              Elimina
            </button>
          }
        >
          {/* Confirmed, because this deletes a file: the persona is the bot as
              much as the name is, and nothing else in ADE holds a copy. */}
          <span data-slot="bots-confirm">
            <span>Eliminare {props.bot.identifier}?</span>
            <button type="button" data-slot="bots-btn" onClick={() => setConfirming(false)}>
              No
            </button>
            <button type="button" data-slot="bots-btn" data-tone="danger" onClick={() => void remove()}>
              Elimina
            </button>
          </span>
        </Show>
      </header>

      <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <Show when={props.bot.mode === "subagent"}>
        {/*
          Said, because nikcli does not say it. Asked to start a session as an
          agent whose mode is `subagent`, `nikcli` warns on its own stderr and
          then falls back to the default agent — so the pane would open, look
          right, carry this bot's name, and be a plain session that has never
          heard of it.
        */}
        <p data-slot="bots-hint">
          Questo bot è un <strong>subagente</strong>: non si avvia da solo, lo chiama un altro
          agente. Avviandolo, nikcli userebbe l'agente predefinito al suo posto.
        </p>
      </Show>

      <BotSettings
        bot={props.bot}
        models={props.models}
        onSaved={() => props.onChanged()}
        {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
      />
    </div>
  )
}

/**
 * What a bot is set to, and how to change it.
 *
 * Four decisions, in the order they matter: which model it runs on, how hard
 * that model is asked to think, what it is always working towards, and who it
 * is. The first two are frontmatter keys nikcli reads directly; the last two
 * are the system prompt, split at a heading so the objectives can have a field
 * of their own without inventing a second file. See `splitPrompt`.
 *
 * Saved explicitly rather than on every keystroke: this writes a file that
 * nikcli may be reading and that the user may have open in the editor, and a
 * write per character would be a fight between the two.
 */
function BotSettings(props: {
  bot: AgentFile
  models: readonly string[]
  onSaved: () => void
  onOpenFile?: (path: string) => void
}) {
  const parts = createMemo(() => splitPrompt(props.bot.prompt))

  const [description, setDescription] = createSignal(props.bot.description)
  const [model, setModel] = createSignal(props.bot.model ?? "")
  const [effort, setEffort] = createSignal(props.bot.effort ?? "")
  const [objectives, setObjectives] = createSignal(parts().objectives.join("\n"))
  const [persona, setPersona] = createSignal(parts().persona)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal(false)

  /* Re-seeded when the roster reloads or another bot is opened: these are
     fields over a file, and the file is the truth. */
  createEffect(
    on(
      () => props.bot.path + props.bot.prompt + (props.bot.model ?? "") + (props.bot.effort ?? ""),
      () => {
        setDescription(props.bot.description)
        setModel(props.bot.model ?? "")
        setEffort(props.bot.effort ?? "")
        setObjectives(parts().objectives.join("\n"))
        setPersona(parts().persona)
        setSaved(false)
      },
      { defer: true },
    ),
  )

  const dirty = createMemo(
    () =>
      description() !== props.bot.description ||
      model() !== (props.bot.model ?? "") ||
      effort() !== (props.bot.effort ?? "") ||
      persona() !== parts().persona ||
      objectives() !== parts().objectives.join("\n"),
  )

  const save = async (event: Event) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setFailure(undefined)

    const problem = await updateBot(props.bot, {
      description: description().trim(),
      model: model() || undefined,
      effort: effort().trim() || undefined,
      persona: persona(),
      objectives: objectives()
        .split("\n")
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0),
    })

    setBusy(false)
    if (problem) {
      setFailure(problem)
      return
    }
    setSaved(true)
    props.onSaved()
  }

  return (
    <form data-slot="bots-form" onSubmit={(e) => void save(e)}>
      <label data-slot="bots-field">
        <span data-slot="bots-label">Quando usarlo</span>
        <input
          data-slot="bots-input"
          value={description()}
          onInput={(event) => setDescription(event.currentTarget.value)}
        />
        <span data-slot="bots-hint">
          È il <code>description</code> del file: nikcli lo legge per decidere quando chiamare questo
          bot come subagente.
        </span>
      </label>

      <div data-slot="bots-row-fields">
        <label data-slot="bots-field">
          <span data-slot="bots-label">Modello</span>
          <select
            data-slot="bots-input"
            value={model()}
            onChange={(event) => setModel(event.currentTarget.value)}
          >
            <option value="">Predefinito di nikcli</option>
            {/* The bot's own model is offered even when it is not in the list:
                nikcli may be configured for a provider this machine cannot
                enumerate right now, and dropping the pin would silently move
                the bot to another model. */}
            <Show when={props.bot.model && !props.models.includes(props.bot.model)}>
              <option value={props.bot.model}>{props.bot.model}</option>
            </Show>
            <For each={props.models}>{(id) => <option value={id}>{id}</option>}</For>
          </select>
        </label>

        <label data-slot="bots-field">
          <span data-slot="bots-label">Sforzo</span>
          <input
            data-slot="bots-input"
            list="bots-efforts"
            value={effort()}
            placeholder="predefinito"
            onInput={(event) => setEffort(event.currentTarget.value)}
          />
          <datalist id="bots-efforts">
            <For each={COMMON_EFFORTS}>{(value) => <option value={value} />}</For>
          </datalist>
          <span data-slot="bots-hint">
            {/* Suggestions, not a closed set: the legal names come from the
                chosen model's own variant table, and nikcli drops a name the
                model does not declare without saying so. Better to name the
                consequence than to pretend ADE knows every provider. */}
            Quanto far ragionare il modello. I nomi validi dipendono dal modello: se non lo prevede,
            nikcli ignora il valore senza avvisare.
          </span>
        </label>
      </div>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Obiettivi</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="4"
          value={objectives()}
          placeholder={"Uno per riga.\nEs. Segnala i rischi prima delle opinioni"}
          onInput={(event) => setObjectives(event.currentTarget.value)}
        />
        <span data-slot="bots-hint">
          Uno per riga. Finiscono nel prompt sotto <code>{OBJECTIVES_HEADING}</code>: nikcli non ha
          un campo per gli obiettivi, ha un prompt, e questa è la parte di prompt che resta vera
          per ogni conversazione.
        </span>
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Persona</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="10"
          value={persona()}
          onInput={(event) => setPersona(event.currentTarget.value)}
        />
      </label>

      <Show when={failure()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <div data-slot="bots-form-actions">
        <Show when={props.onOpenFile}>
          {(open) => (
            <button type="button" data-slot="bots-btn" onClick={() => open()(props.bot.path)}>
              Apri il file
            </button>
          )}
        </Show>
        <span data-slot="bots-hint" data-state={saved() && !dirty() ? "saved" : undefined}>
          {saved() && !dirty() ? "Salvato." : dirty() ? "Modifiche non salvate." : ""}
        </span>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy() || !dirty()}>
          {busy() ? "Salvataggio…" : "Salva"}
        </button>
      </div>
    </form>
  )
}
