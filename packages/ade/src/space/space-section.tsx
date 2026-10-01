import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { t } from "../i18n"
import { createSpace, formatBytes, type Group, type Outcome, type Row, type SpaceDeps } from "./space"
import "./space.css"

/**
 * «Spazio su disco»: the rows of `createSpace`, drawn. All the rules (what is offered, what is only listed, the question before every
 * removal) are the controller's; this only shows its rows and passes the clicks on. Loaded when the section is opened, so ADE with the
 * panel closed never reads a folder for it.
 */

const GROUPS: readonly Group[] = ["voices", "assets", "worktrees", "branches", "project"]

export function SpaceSection(props: SpaceDeps) {
  const space = createSpace(props)
  const [rows, setRows] = createSignal<Row[]>([])
  const [busy, setBusy] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; failed: boolean }>()
  let alive = true
  onCleanup(() => (alive = false))

  const stop = space.onChange(() => {
    if (!alive) return
    setRows([...space.rows()])
    setBusy(space.busy())
  })
  onCleanup(stop)

  const check = async () => {
    setNotice(undefined)
    await space.refresh().catch(() => undefined)
    if (alive) setLoaded(true)
  }
  onMount(() => void check())

  const say = (outcome: Outcome) => {
    if (outcome.kind === "done") setNotice({ text: t("space.done", formatBytes(outcome.freed)), failed: false })
    else if (outcome.kind === "failed") setNotice({ text: t("space.failed", outcome.reason), failed: true })
    else if (outcome.kind === "listed" && outcome.why) setNotice({ text: t("space.kept", outcome.why), failed: false })
  }

  const inGroup = (group: Group) => rows().filter((row) => row.group === group)

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("space.title")}
        </h3>
        <p data-slot="section-desc">{t("space.desc")}</p>
      </div>

      <div data-slot="space-actions">
        <button type="button" data-slot="settings-choice" data-space="refresh" disabled={busy()} onClick={() => void check()}>
          {t("space.refresh")}
        </button>
        <Show when={busy()}>
          <span data-slot="space-busy" role="status">
            {t("space.busy")}
          </span>
        </Show>
      </div>

      <Show when={notice()}>
        {(note) => (
          <p data-slot="space-notice" data-failed={note().failed ? "true" : undefined} role={note().failed ? "alert" : "status"}>
            {note().text}
          </p>
        )}
      </Show>

      <Show when={loaded() && rows().length === 0}>
        <p data-slot="settings-empty">{t("space.empty")}</p>
      </Show>

      <For each={GROUPS}>
        {(group) => (
          <Show when={inGroup(group).length > 0}>
            <div data-slot="space-group" data-group={group}>
              <h4 data-slot="space-group-title">{t(`space.group.${group}` as "space.group.voices")}</h4>
              <For each={inGroup(group)}>
                {(row) => (
                  <div data-slot="space-row" data-row={row.id} data-kept={row.kept ? "true" : undefined}>
                    <span data-slot="space-row-name">{row.title}</span>
                    <Show when={row.bytes !== undefined}>
                      <span data-slot="space-row-size">{formatBytes(row.bytes!)}</span>
                    </Show>
                    <Show when={row.detail}>
                      <span data-slot="space-row-detail">{row.detail}</span>
                    </Show>
                    <Show when={row.kept}>
                      <span data-slot="space-row-kept">{t("space.kept", row.kept!)}</span>
                    </Show>
                    <Show when={row.action}>
                      <span data-slot="space-row-actions">
                        <button
                          type="button"
                          data-slot="settings-choice"
                          data-space="remove"
                          disabled={busy()}
                          onClick={() => void space.remove(row.id).then(say)}
                        >
                          {row.action}
                        </button>
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </For>
    </>
  )
}

/** The section as the settings panel mounts it: the host is fetched first, and a host that is missing is a panel with no rows. */
export function SpaceSectionLoader(props: Omit<SpaceDeps, "host"> & { host: () => Promise<SpaceDeps["host"] | undefined> }) {
  const [host, setHost] = createSignal<SpaceDeps["host"]>()
  onMount(() => void props.host().then((found) => setHost(found ?? {})))
  return (
    <Show when={host()}>
      {(ready) => <SpaceSection host={ready()} roots={props.roots} openWorktrees={props.openWorktrees} ask={props.ask} now={props.now} />}
    </Show>
  )
}
