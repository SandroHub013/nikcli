import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import {
  afterInstallHint,
  cardAction,
  CATALOG_FILTERS,
  filterCatalog,
  installedServers,
  monogram,
  transportLabel,
  type CatalogFilter,
  type InstalledServer,
} from "./extensions"
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp-catalog"
import { addMcpServerToProject, MCP_CONFIG_FILENAME, readProjectMcpConfig, removeMcpServerFromProject, type McpConfigIO } from "./mcp-config"
import "./extensions.css"

/*
 * Logos are files in this folder, bundled at build time: Simple Icons (CC0,
 * pinned in `logos/SOURCES.md`) and the vendors' own SVGs where one was
 * verified. Nothing is fetched at runtime, so opening the page tells no
 * logo host which servers the user looks at, and it works offline.
 */
const LOGO_URLS = import.meta.glob("./logos/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>

function logoUrl(entry: McpCatalogEntry): { url: string; mono: boolean } | undefined {
  const file = entry.logo.kind === "simple-icons" ? `${entry.logo.id}.svg` : entry.logo.file
  const url = LOGO_URLS[`./logos/${file}`]
  // Simple Icons are single-colour marks, drawn in the theme's ink; official files keep their colours.
  return url ? { url, mono: entry.logo.kind === "simple-icons" } : undefined
}

function Logo(props: { entry?: McpCatalogEntry; name: string }) {
  const logo = () => (props.entry ? logoUrl(props.entry) : undefined)
  return (
    <Show
      when={logo()}
      fallback={
        <span data-slot="ext-logo" data-monogram="true" aria-hidden="true">
          {monogram(props.entry?.name ?? props.name)}
        </span>
      }
    >
      {(found) =>
        found().mono ? (
          <span
            data-slot="ext-logo"
            data-mono="true"
            aria-hidden="true"
            style={{ "mask-image": `url("${found().url}")`, "-webkit-mask-image": `url("${found().url}")` }}
          />
        ) : (
          <span data-slot="ext-logo" aria-hidden="true">
            <img src={found().url} alt="" />
          </span>
        )
      }
    </Show>
  )
}

export type ExtensionsTab = "installati" | "catalogo" | "plugin"

/**
 * Impostazioni › Estensioni: MCP servers and ADE plugins on one page.
 *
 * Installing writes only the project's `.mcp.json`, which Claude Code and the
 * other CLIs read when a session starts there; nothing global, and no secret
 * values — a definition carries `${VARIABILE}` references the agent resolves
 * from its environment.
 */
export function ExtensionsPage(props: {
  projectRoot: string | undefined
  io: McpConfigIO | undefined
  /** The plugin rows, as the settings panel already renders them. */
  plugins: () => JSX.Element
  pluginCount: number
  onOpenGuide: (url: string) => void
}) {
  const [tab, setTab] = createSignal<ExtensionsTab>("catalogo")
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<CatalogFilter>("tutti")
  const [busy, setBusy] = createSignal<string>()
  const [notice, setNotice] = createSignal<{ tone: "ok" | "error"; text: string }>()

  const [config, { refetch }] = createResource(
    () => (props.projectRoot && props.io ? props.projectRoot : undefined),
    async (root) => {
      try {
        return { raw: await readProjectMcpConfig(root, props.io!) }
      } catch (failure) {
        return { raw: undefined, error: failure instanceof Error ? failure.message : String(failure) }
      }
    },
  )

  const installed = createMemo<{ servers: InstalledServer[]; error?: string }>(() => {
    const current = config()
    if (!current) return { servers: [] }
    if (current.error) return { servers: [], error: current.error }
    try {
      return { servers: installedServers(current.raw) }
    } catch (failure) {
      return { servers: [], error: failure instanceof Error ? failure.message : String(failure) }
    }
  })

  const cards = createMemo(() => filterCatalog(MCP_CATALOG, query(), filter()))

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    if (busy()) return
    setBusy(key)
    setNotice(undefined)
    try {
      await action()
      setNotice({ tone: "ok", text: done })
      await refetch()
    } catch (failure) {
      setNotice({ tone: "error", text: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const add = (entry: McpCatalogEntry) =>
    run(
      entry.id,
      () => addMcpServerToProject(props.projectRoot!, entry.installation.config, props.io!),
      `${entry.name} aggiunto a ${MCP_CONFIG_FILENAME}. ${afterInstallHint(entry)} Vale per le sessioni avviate da ora.`,
    )

  const remove = (server: InstalledServer) =>
    run(
      `rm:${server.name}`,
      () => removeMcpServerFromProject(props.projectRoot!, server.name, props.io!),
      `${server.name} tolto da ${MCP_CONFIG_FILENAME}.`,
    )

  const tabs: { id: ExtensionsTab; label: () => string }[] = [
    { id: "installati", label: () => `Installati · ${installed().servers.length + props.pluginCount}` },
    { id: "catalogo", label: () => `Catalogo MCP · ${MCP_CATALOG.length}` },
    { id: "plugin", label: () => `Plugin · ${props.pluginCount}` },
  ]

  return (
    <div data-component="extensions-page">
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Estensioni
        </h3>
        <p data-slot="section-desc">
          Server MCP e plugin. "Aggiungi al progetto" scrive solo il {MCP_CONFIG_FILENAME} del progetto aperto, che le CLI
          agente leggono all'avvio della sessione; le credenziali restano fuori dal file.
        </p>
      </div>

      <div data-slot="ext-tabs" role="tablist" aria-label="Estensioni">
        <For each={tabs}>
          {(item) => (
            <button
              type="button"
              role="tab"
              data-slot="ext-tab"
              aria-selected={tab() === item.id}
              data-active={tab() === item.id ? "true" : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label()}
            </button>
          )}
        </For>
      </div>

      <Show when={notice()}>
        {(current) => (
          <p data-slot="ext-notice" data-tone={current().tone} role={current().tone === "error" ? "alert" : "status"}>
            {current().text}
          </p>
        )}
      </Show>
      <Show when={!props.projectRoot}>
        <p data-slot="ext-notice" data-tone="error">Apri un progetto per aggiungere server MCP: si installano nel suo {MCP_CONFIG_FILENAME}.</p>
      </Show>

      <Show when={tab() === "catalogo"}>
        <div data-slot="ext-toolbar">
          <input
            type="search"
            data-slot="ext-search"
            placeholder="Cerca un server: Stripe, calendario, database…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label="Cerca nel catalogo"
          />
          <div data-slot="ext-filters" role="group" aria-label="Filtro">
            <For each={CATALOG_FILTERS}>
              {(item) => (
                <button
                  type="button"
                  data-slot="ext-filter"
                  aria-pressed={filter() === item.id}
                  data-active={filter() === item.id ? "true" : undefined}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={cards().length > 0} fallback={<p data-slot="settings-meta">Nessun server corrisponde.</p>}>
          <ul data-slot="ext-grid">
            <For each={cards()}>
              {(entry) => {
                const action = () => cardAction(entry, installed().servers)
                return (
                  <li data-slot="ext-card" data-origin={entry.origin}>
                    <div data-slot="ext-card-head">
                      <Logo entry={entry} name={entry.name} />
                      <div data-slot="ext-card-title">
                        <b>{entry.name}</b>
                        <Show when={entry.publisher !== entry.name}>
                          <span>{entry.publisher}</span>
                        </Show>
                      </div>
                      <span data-slot="ext-badge" data-origin={entry.origin}>
                        {entry.origin === "official" ? "ufficiale" : "community"}
                      </span>
                    </div>
                    <p data-slot="ext-card-desc">{entry.description}</p>
                    <div data-slot="ext-card-meta">
                      <span>{transportLabel(entry.transport)}</span>
                      <span>{entry.authentication.label}</span>
                    </div>
                    <Show when={entry.warning}>
                      <p data-slot="ext-warning">{entry.warning}</p>
                    </Show>
                    <div data-slot="ext-card-actions">
                      <Show when={action().kind === "installed"}>
                        <span data-slot="ext-installed">✓ Nel progetto</span>
                      </Show>
                      <Show when={action().kind === "add"}>
                        <button
                          type="button"
                          data-slot="settings-choice"
                          data-active="true"
                          disabled={!props.projectRoot || !props.io || busy() !== undefined}
                          onClick={() => void add(entry)}
                        >
                          {busy() === entry.id ? "Aggiungo…" : "Aggiungi al progetto"}
                        </button>
                      </Show>
                      <Show when={action().kind === "name-taken"}>
                        <span data-slot="ext-warning">
                          «{entry.installation.config.name}» è già usato in {MCP_CONFIG_FILENAME} da un altro server
                        </span>
                      </Show>
                      <Show when={action().kind === "guide"}>
                        <button
                          type="button"
                          data-slot="settings-choice"
                          onClick={() => props.onOpenGuide(entry.installation.guideUrl)}
                          title="Non installabile con un clic: si apre la guida ufficiale"
                        >
                          Guida alla configurazione
                        </button>
                      </Show>
                      <button type="button" data-slot="ext-link" onClick={() => props.onOpenGuide(entry.sourceUrl)}>
                        Fonte
                      </button>
                    </div>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={tab() === "installati"}>
        <h4 data-slot="ext-group">Server MCP del progetto</h4>
        <Show when={installed().error}>
          <p data-slot="ext-notice" data-tone="error">{installed().error}</p>
        </Show>
        <Show
          when={installed().servers.length > 0}
          fallback={<p data-slot="settings-meta">Nessun server in {MCP_CONFIG_FILENAME}. Aggiungine uno dal catalogo.</p>}
        >
          <ul data-slot="ext-installed-list">
            <For each={installed().servers}>
              {(server) => (
                <li data-slot="ext-row">
                  <Logo entry={server.entry} name={server.name} />
                  <div data-slot="ext-row-text">
                    <b>{server.entry?.name ?? server.name}</b>
                    <code>{server.detail || "definizione incompleta"}</code>
                    <Show when={server.variables.length > 0}>
                      <span data-slot="settings-meta">variabili: {server.variables.join(", ")}</span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    data-slot="settings-choice"
                    disabled={busy() !== undefined}
                    onClick={() => void remove(server)}
                  >
                    {busy() === `rm:${server.name}` ? "Tolgo…" : "Rimuovi"}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <h4 data-slot="ext-group">Plugin di ADE</h4>
        {props.plugins()}
      </Show>

      <Show when={tab() === "plugin"}>{props.plugins()}</Show>
    </div>
  )
}
