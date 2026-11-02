import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import { BRAND } from "../brand"
import type { AgentFile } from "../bots/ragu"
import { listBots, resolveRoots } from "../bots/store"
import { QUALITY_LEVELS, qualityLabel, qualityLevel, sizePerMinute, type RecordQuality } from "../record/recording"
import { LOCALE_PREFERENCES, locale, localePreference, setLocalePreference, t, type LocalePreference } from "../i18n"
import { DEFAULT_GLASS_OPACITY, GLASS_READABLE_MIN, THEME_CHOICES, isGlassReadable, type Theme } from "../theme"
import type { GlassStatus } from "../surface/glass-window"
import { shortcutGroups } from "../keyboard/shortcuts-list"
import type { Platform } from "../keyboard/keymap"
import { Button } from "../ui/controls"
import { PillTabs } from "../ui/pill-tabs"
import "./sections.css"

/**
 * ADE's own screens inside the settings panel.
 *
 * The panel itself is `SettingsShell`, which owns the categories, the tabs
 * and the modal chrome; these are the contents of the tabs. Each screen names
 * itself in prose under `section-desc` only: the shell's header already shows
 * the category and the tab bar the tab, and a third heading inside the body
 * ("Tema" under "Aspetto") was one more name for the same screen.
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
        {t("settings.notBuilt")}
        <Show when={props.instead}>{(instead) => <> {instead()}</>}</Show>
      </p>
    </>
  )
}

export interface BotSectionProps {
  /** The open project, so project bots are listed as well as global ones. */
  projectRoot?: string
}

/**
 * The bots, as configuration rather than as a place to talk to them.
 *
 * Read-only on purpose, and read from the same place ragu reads: a bot is an
 * agent file under `.nikcli/agent/` or in ragu's global configuration, so
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
        <h4 data-slot="section-subtitle">{t("settings.bots.title")}</h4>
        <p data-slot="section-desc">{t("settings.bots.desc")}</p>
      </div>

      <Show
        when={roster().length > 0}
        fallback={<p data-slot="settings-empty">{ready() ? t("settings.bots.empty") : t("settings.bots.reading")}</p>}
      >
        <ul data-slot="settings-list">
          <For each={roster()}>
            {(bot) => (
              <li data-slot="settings-row">
                <span data-slot="settings-glyph" aria-hidden="true">
                  {bot.identifier.slice(0, 1).toUpperCase()}
                </span>
                <span data-slot="settings-name">{bot.identifier}</span>
                <span data-slot="settings-meta">{bot.model ?? t("settings.bots.defaultModel")}</span>
                <span data-slot="settings-meta">
                  {bot.scope === "project" ? t("settings.bots.scopeProject") : t("settings.bots.scopeGlobal")}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

const unquoted = (tool: string) => tool.replace(/^(["'])(.*)\1$/, "$2")

export interface SkillsSectionProps {
  projectRoot?: string
}

/**
 * The tools the bots are allowed, seen from the side of who uses them.
 *
 * ragu's agents do not carry "skills"; they carry a tool list, and what a
 * file records is the tools that have been switched *off*. So the honest
 * reading is per-bot: which ones each has given up. A catalogue of everything
 * ragu can do belongs to ragu, and inventing one here would be a list ADE
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
        <h4 data-slot="section-subtitle">{t("settings.skills.title")}</h4>
        <p data-slot="section-desc">{t("settings.skills.desc")}</p>
      </div>

      <Show
        when={restricted().length > 0}
        fallback={<p data-slot="settings-empty">{t("settings.skills.empty")}</p>}
      >
        <ul data-slot="settings-list">
          <For each={restricted()}>
            {(bot) => {
              /* The file spells the key as it is written there: `"*": false`, quotes included. */
              const disabled = () => bot.disabledTools.map(unquoted)
              return (
                <li data-slot="settings-row">
                  <span data-slot="settings-name">{bot.identifier}</span>
                  <span data-slot="settings-meta">
                    {disabled().includes("*")
                      ? t("settings.skills.none")
                      : t("settings.skills.without", disabled().join(", "))}
                  </span>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>

      <p data-slot="settings-hint">{t("settings.skills.addHint")}</p>
    </>
  )
}

export interface ThemeSectionProps {
  /** Defaults to the app's own state; a test passes its own to watch the choice. */
  value?: () => Theme
  onChange?: (next: Theme) => void
  opacity?: () => number
  onOpacityChange?: (next: number) => void
  glassStatus?: () => GlassStatus | undefined
}

/**
 * Which theme ADE's interface renders (S49).
 *
 * Light, dark, or transparent glass with native blur effect, plus system fallback.
 * When glass is active, an opacity slider controls transparency while keeping
 * text contrast legible.
 */
export function ThemeSection(props: ThemeSectionProps) {
  const value = () => (props.value ? props.value() : "system")
  const choose = (next: Theme) => props.onChange?.(next)
  const opacity = () => (props.opacity ? props.opacity() : DEFAULT_GLASS_OPACITY)
  const status = () => props.glassStatus?.()

  const label = (choice: Theme) => {
    switch (choice) {
      case "light":
        return t("settings.theme.light")
      case "dark":
        return t("settings.theme.dark")
      case "glass":
        return t("settings.theme.glass")
      case "system":
        return t("settings.theme.system")
    }
  }

  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("settings.theme.desc")}</p>
      </div>

      <div data-slot="settings-choices">
        <PillTabs
          role="button"
          popup={false}
          dataSlot="ade-pill-tabs"
          ariaLabel={t("settings.theme.group")}
          items={THEME_CHOICES.map((choice) => ({
            id: choice,
            label: label(choice),
            active: value() === choice,
            attrs: { "data-theme-choice": choice },
          }))}
          onSelect={(id) => choose(id as (typeof THEME_CHOICES)[number])}
        />
      </div>

      <Show when={status() && status()!.supported === false}>
        <p data-slot="settings-notice" data-state="warning">
          {status()!.reason ?? t("settings.theme.unsupported")}
        </p>
      </Show>

      <Show when={value() === "glass"}>
        <div data-slot="settings-slider-group">
          <div data-slot="settings-slider-header">
            <label for="glass-opacity-slider" data-slot="settings-slider-label">
              {t("settings.theme.opacity")}
            </label>
            <span data-slot="settings-slider-value">{opacity()}%</span>
          </div>
          <input
            id="glass-opacity-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value={opacity()}
            data-slot="settings-slider"
            aria-label={t("settings.theme.opacity")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={opacity()}
            aria-valuetext={`${opacity()}%`}
            onInput={(e) => props.onOpacityChange?.(Number(e.currentTarget.value))}
          />
          {/*
           * One line, which changes rather than accumulating: under the
           * readable minimum it says what the user is trading away, and does
           * not stop them doing it.
           */}
          <p data-slot="settings-slider-desc">
            {isGlassReadable(opacity())
              ? t("settings.theme.opacityDesc", GLASS_READABLE_MIN)
              : t("settings.theme.opacityLow", GLASS_READABLE_MIN)}
          </p>
        </div>
      </Show>
    </>
  )
}

export interface LanguageSectionProps {
  /** Defaults to the app's own state; a test passes its own to watch the choice. */
  value?: () => LocalePreference
  onChange?: (next: LocalePreference) => void
}

/**
 * Which language ADE's interface speaks (S41).
 *
 * Three choices rather than two: "System" is what a fresh install uses, and
 * showing it with the language it resolves to answers "why is this English?"
 * without a trip to the OS settings. Each language is named in itself, so a
 * person who cannot read the current one still finds their own.
 */
export function LanguageSection(props: LanguageSectionProps) {
  const value = () => (props.value ?? localePreference)()
  const choose = (next: LocalePreference) => (props.onChange ?? setLocalePreference)(next)
  const label = (choice: LocalePreference) =>
    choice === "system"
      ? t("settings.language.systemNow", t(locale() === "it" ? "settings.language.it" : "settings.language.en"))
      : t(choice === "it" ? "settings.language.it" : "settings.language.en")

  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("settings.language.desc")}</p>
      </div>

      <div data-slot="settings-choices">
        <PillTabs
          role="button"
          popup={false}
          dataSlot="ade-pill-tabs"
          ariaLabel={t("settings.language.group")}
          items={LOCALE_PREFERENCES.map((choice) => ({
            id: choice,
            label: label(choice),
            active: value() === choice,
            attrs: { "data-locale": choice, lang: choice === "system" ? undefined : choice },
          }))}
          onSelect={(id) => choose(id as LocalePreference)}
        />
      </div>
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
        <p data-slot="section-desc">{t("settings.grid.desc")}</p>
      </div>

      <div data-slot="settings-choices">
        <PillTabs
          role="button"
          popup={false}
          dataSlot="ade-pill-tabs"
          ariaLabel={t("settings.grid.columns")}
          items={GRID_COLUMN_CHOICES.map((value) => ({
            id: value === undefined ? "auto" : String(value),
            label: value === undefined ? t("settings.grid.auto") : String(value),
            active: props.columns === value,
          }))}
          onSelect={(id) => props.onChange(id === "auto" ? undefined : Number(id))}
        />
      </div>
    </>
  )
}

/**
 * The keys ADE answers to, grouped by where they work.
 *
 * Read from the keymap and from `runsFromTerminal` (`keyboard/shortcuts-list`), so the page cannot list a key the
 * workbench would hand to the terminal.
 */
export function ShortcutsSection(props: { platform: Platform }) {
  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("shortcuts.desc")}</p>
      </div>
      <For each={shortcutGroups(props.platform)}>
        {(group) => (
          <Show when={group.rows.length > 0}>
            <section aria-label={t(group.titleKey)} data-slot="shortcuts-group">
              <p data-slot="section-desc">
                <strong>{t(group.titleKey)}</strong>
                <Show when={group.noteKey}>{(note) => <> {t(note())}</>}</Show>
              </p>
              <ul data-slot="settings-list">
                <For each={group.rows}>
                  {(row) => (
                    <li data-slot="settings-row">
                      <span data-slot="settings-name">{t(row.labelKey)}</span>
                      <kbd data-slot="ade-kbd">{row.keys}</kbd>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        )}
      </For>
      <p data-slot="section-desc">{t("shortcuts.voice")}</p>
    </>
  )
}

/** Servers ADE would speak the Model Context Protocol to. */
export function McpSection() {
  return <NotBuiltYet title="MCP" what={t("settings.mcp.desc")} instead={t("settings.mcp.instead")} />
}

export interface RecordVideoSectionProps {
  /** What the workbench will record at, read live. */
  quality: () => RecordQuality
  /** The same write the `record.quality` command performs. */
  onQuality: (next: RecordQuality) => void
  /** Whether takes start with the microphone on (`record.mic`). */
  mic: () => boolean
  onMic: (next: boolean) => void
  /** The folder takes are saved to, or `undefined` until one is chosen. */
  dir: () => string | undefined
  /** The same dialog `record.folder` opens. */
  onPickFolder: () => void
  /** The same export `record.export` runs. */
  onExport: () => void
  /** Whether an export is running; while it is, the button gives way to its progress and «Annulla». */
  exporting?: () => boolean
  /** How far the running export is, 0 to 1. */
  exportProgress?: () => number
  /** The export is held because the window is hidden; it goes on when the window is back. */
  exportWaiting?: () => boolean
  /** Stops the running export. */
  onCancelExport?: () => void
}

/**
 * Registrazione › Registrazione video: quality, microphone, folder, export.
 *
 * Every control hands its choice straight to the workbench functions the
 * palette commands call, so the two entrances are one setting, not two that
 * can drift; the current value is read live, and nothing is stored here.
 */
export function RecordVideoSection(props: RecordVideoSectionProps) {
  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("settings.category.record.desc")}</p>
      </div>

      <div data-slot="settings-choices">
        <PillTabs
          role="button"
          popup={false}
          dataSlot="ade-pill-tabs"
          ariaLabel={t("settings.record.quality")}
          items={QUALITY_LEVELS.map((level) => ({
            id: level.id,
            label: qualityLabel(level),
            active: props.quality() === level.id,
            attrs: { "data-quality": level.id },
          }))}
          onSelect={(id) => props.onQuality(id as RecordQuality)}
        />
      </div>
      <p data-slot="settings-meta">{sizePerMinute(qualityLevel(props.quality()))}</p>

      <div data-slot="settings-choices">
        <PillTabs
          role="button"
          popup={false}
          dataSlot="ade-pill-tabs"
          ariaLabel={t("settings.record.mic")}
          items={[
            { id: "on", label: t("settings.record.mic.on"), active: props.mic(), attrs: { "data-mic": "on" } },
            { id: "off", label: t("settings.record.mic.off"), active: !props.mic(), attrs: { "data-mic": "off" } },
          ]}
          onSelect={(id) => props.onMic(id === "on")}
        />
      </div>

      <ul data-slot="settings-list">
        <li data-slot="settings-row">
          <span data-slot="settings-name">{t("settings.record.folder")}</span>
          <span data-slot="settings-meta">{props.dir() ?? t("settings.record.folder.none")}</span>
          <Button onClick={() => props.onPickFolder()}>{t("settings.record.folder.choose")}</Button>
        </li>
      </ul>

      <div data-slot="settings-choices">
        <Show
          when={props.exporting?.()}
          fallback={
            <Button data-action="record.export" onClick={() => props.onExport()}>
              {t("settings.record.export")}
            </Button>
          }
        >
          <span
            data-slot="settings-meta"
            data-export="progress"
            data-waiting={props.exportWaiting?.() ? "true" : undefined}
            role="status"
          >
            {props.exportWaiting?.()
              ? t("settings.record.export.waiting")
              : t("settings.record.export.progress", Math.round((props.exportProgress?.() ?? 0) * 100))}
          </span>
          <Button data-action="record.export.cancel" onClick={() => props.onCancelExport?.()}>
            {t("settings.record.export.cancel")}
          </Button>
        </Show>
      </div>
      <p data-slot="settings-meta">{t("settings.record.export.desc")}</p>
    </>
  )
}

export interface UpdatesSectionProps {
  /** The installed version; while it is unknown the row is not drawn. */
  version?: string
  /** Whether the check is running, shared with the bell's button. */
  checking: () => boolean
  /** The update the last check found, if any. */
  available: () => { version: string } | undefined
  /** The same check `update.check` runs. */
  onCheck: () => void
  /** Opens the same `UpdateDialog` a release notice opens. */
  onInstall: () => void
}

/**
 * Sistema › Aggiornamenti: the version, the check, and the release found.
 *
 * The check and the dialog are the workbench's own — the bell and the
 * palette reach them from here unchanged, so "Controlla aggiornamenti" can
 * never mean two different things.
 */
export function UpdatesSection(props: UpdatesSectionProps) {
  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc">{t("settings.updates.desc")}</p>
      </div>

      <Show when={props.version}>
        {(version) => (
          <p data-slot="settings-meta">
            {t("settings.updates.installed")} ADE {version()}
          </p>
        )}
      </Show>

      <div data-slot="settings-choices">
        <Button data-action="update.check" disabled={props.checking()} onClick={() => props.onCheck()}>
          {props.checking() ? t("update.checking") : t("palette.update.check")}
        </Button>
      </div>

      <Show when={props.available()}>
        {(update) => (
          <div data-slot="settings-notice" data-state="info" role="status">
            <span>{t("update.available", update().version)}</span>
            <Button variant="primary" size="sm" data-action="update.install" onClick={() => props.onInstall()}>
              {t("update.restart.ok")}
            </Button>
          </div>
        )}
      </Show>
    </>
  )
}

/**
 * The folder ADE keeps its own data in, as the desktop app knows it. Outside the
 * desktop app (the browser, the tests) there is none: the row says so.
 */
async function appDataFolder(): Promise<string | undefined> {
  try {
    return await (await import("@tauri-apps/api/path")).appLocalDataDir()
  } catch {
    return undefined
  }
}

export interface AboutSectionProps {
  readonly version?: string | undefined
  /** Where the data folder comes from; tests give their own. */
  readonly dataFolder?: () => Promise<string | undefined>
}

/** About: the name people read, the tagline, the version and the data folder, as plain rows. */
export function AboutSection(props: AboutSectionProps) {
  const [folder] = createResource(() => (props.dataFolder ?? appDataFolder)())
  return (
    <>
      <div data-slot="section-head">
        <p data-slot="section-desc" data-about="name">
          {BRAND.title}
        </p>
        <p data-slot="settings-meta" data-about="tagline">
          {BRAND.tagline}
        </p>
      </div>
      <p data-slot="settings-meta" data-about="version">
        {t("settings.about.version")}: {props.version ?? t("settings.about.unknown")}
      </p>
      <p data-slot="settings-meta" data-about="folder">
        {t("settings.about.folder")}: <span data-slot="settings-path">{folder.loading ? "…" : (folder() ?? t("settings.about.unknown"))}</span>
      </p>
    </>
  )
}
