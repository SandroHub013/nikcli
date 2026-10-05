import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { AgentFile } from "../bots/nikcli"
import { listBots, resolveRoots } from "../bots/store"
import { QUALITY_LEVELS, qualityLevel, sizePerMinute, type RecordQuality } from "../record/recording"
import { LOCALE_PREFERENCES, locale, localePreference, setLocalePreference, t, type LocalePreference } from "../i18n"
import { DEFAULT_GLASS_OPACITY, GLASS_READABLE_MIN, THEME_CHOICES, isGlassReadable, type Theme } from "../theme"
import type { GlassStatus } from "../surface/glass-window"
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

      <div data-slot="settings-choices" role="group" aria-label={t("settings.theme.group")}>
        <For each={THEME_CHOICES}>
          {(choice) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-theme-choice={choice}
              data-active={value() === choice ? "true" : undefined}
              aria-pressed={value() === choice}
              onClick={() => choose(choice)}
            >
              {label(choice)}
            </button>
          )}
        </For>
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

      <div data-slot="settings-choices" role="group" aria-label={t("settings.language.group")}>
        <For each={LOCALE_PREFERENCES}>
          {(choice) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-locale={choice}
              data-active={value() === choice ? "true" : undefined}
              aria-pressed={value() === choice}
              lang={choice === "system" ? undefined : choice}
              onClick={() => choose(choice)}
            >
              {label(choice)}
            </button>
          )}
        </For>
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

      <div data-slot="settings-choices" role="group" aria-label={t("settings.grid.columns")}>
        <For each={GRID_COLUMN_CHOICES}>
          {(value) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-active={props.columns === value ? "true" : undefined}
              aria-pressed={props.columns === value}
              onClick={() => props.onChange(value)}
            >
              {value === undefined ? t("settings.grid.auto") : value}
            </button>
          )}
        </For>
      </div>
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

      <div data-slot="settings-choices" role="group" aria-label={t("settings.record.quality")}>
        <For each={QUALITY_LEVELS}>
          {(level) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-quality={level.id}
              data-active={props.quality() === level.id ? "true" : undefined}
              aria-pressed={props.quality() === level.id}
              onClick={() => props.onQuality(level.id)}
            >
              {level.label}
            </button>
          )}
        </For>
      </div>
      <p data-slot="settings-meta">{sizePerMinute(qualityLevel(props.quality()))}</p>

      <div data-slot="settings-choices" role="group" aria-label={t("settings.record.mic")}>
        <button
          type="button"
          data-slot="settings-choice"
          data-mic="on"
          data-active={props.mic() ? "true" : undefined}
          aria-pressed={props.mic()}
          onClick={() => props.onMic(true)}
        >
          {t("settings.record.mic.on")}
        </button>
        <button
          type="button"
          data-slot="settings-choice"
          data-mic="off"
          data-active={!props.mic() ? "true" : undefined}
          aria-pressed={!props.mic()}
          onClick={() => props.onMic(false)}
        >
          {t("settings.record.mic.off")}
        </button>
      </div>

      <ul data-slot="settings-list">
        <li data-slot="settings-row">
          <span data-slot="settings-name">{t("settings.record.folder")}</span>
          <span data-slot="settings-meta">{props.dir() ?? t("settings.record.folder.none")}</span>
          <button type="button" data-slot="settings-choice" onClick={() => props.onPickFolder()}>
            {t("settings.record.folder.choose")}
          </button>
        </li>
      </ul>

      <div data-slot="settings-choices">
        <button type="button" data-slot="settings-choice" data-action="record.export" onClick={() => props.onExport()}>
          {t("settings.record.export")}
        </button>
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
        <button
          type="button"
          data-slot="settings-choice"
          data-action="update.check"
          disabled={props.checking()}
          onClick={() => props.onCheck()}
        >
          {props.checking() ? t("update.checking") : t("palette.update.check")}
        </button>
      </div>

      <Show when={props.available()}>
        {(update) => (
          <div data-slot="settings-notice" data-state="info" role="status">
            <span>{t("update.available", update().version)}</span>
            <button
              type="button"
              data-slot="settings-choice"
              data-action="update.install"
              onClick={() => props.onInstall()}
            >
              {t("update.restart.ok")}
            </button>
          </div>
        )}
      </Show>
    </>
  )
}
