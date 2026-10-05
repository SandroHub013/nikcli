import { lazy, For, Show, Suspense, type JSX } from "solid-js"
import {
  createVoiceSettingsState,
  VOICE_SETTINGS_PAGES,
  VoiceListenButton,
  VoiceSettingsPage,
  VoiceStatusBar,
  type VoiceSettingsPageId,
  type VoiceSettingsStateProps,
  type VoiceEngine,
  type VoiceSettings,
  type ReplyVoice,
  type InstallProgress,
  type LocalProvider,
  type PackState,
  type MaiFailureKind,
} from "@nikcli-ai/voice"
import type { Binding } from "../keyboard/keymap"
import { getHost } from "../host/shell"
import type { KeysHost } from "../secrets/keys-section"
import { type HookHost, type HookStatus } from "../session-new/agent-hooks"
import { AgentHooksSection } from "../session-new/agent-hooks-panel"
import { AGENTS } from "../session-new/agents"
import type { Runner } from "../bots/runners"
import type { McpConfigIO } from "../extensions/mcp-config"
import type { createAdePluginRuntime } from "../plugin/runtime"
import { setColumns, type Workbench } from "../surface/state"
import type { Theme } from "../theme"
import type { GlassStatus } from "../surface/glass-window"
import { t } from "../i18n"
import {
  BotSection,
  GridSection,
  LanguageSection,
  RecordVideoSection,
  SkillsSection,
  ThemeSection,
  UpdatesSection,
} from "./sections"
import { AccountSection } from "./account"
import type { RecordQuality } from "../record/recording"
import { KeysSection } from "../secrets/keys-section"
import { ExtensionsPage } from "../extensions/extensions-page"
import { PluginSection } from "../plugin/pane"
import { SettingsShell } from "./shell"
import type { CategoryId } from "./categories"

const SpaceSection = lazy(() =>
  import("../space/space-section").then((module) => ({ default: module.SpaceSectionLoader })),
)
const FramePluginRows = lazy(() =>
  import("../plugin-frame/plugin-rows").then((module) => ({ default: module.FramePluginRows })),
)

export interface SettingsSheetProps {
  onClose: () => void
  initialTarget?: string
  version?: string
  onCheckUpdates?: () => void

  // Voice dependencies
  voiceEngine: VoiceEngine
  voiceSettings: VoiceSettings
  onVoiceSettingsChange: (next: VoiceSettings) => void
  shortcutRefusals?: { agent?: string; transcription?: string }
  onOpenVoiceSource?: (voice: ReplyVoice) => void
  naturalVoiceError?: string
  naturalVoiceDownloading?: boolean
  onDownloadNaturalVoice?: () => void
  naturalVoiceProgress?: InstallProgress
  onCancelInstall?: (provider: LocalProvider) => void
  kokoroPack?: PackState
  onInstallKokoro?: () => void
  onDeleteKokoro?: () => void
  onTestVoice?: () => void
  maiBlocked?: MaiFailureKind
  onRetryMai?: () => void
  testIdentity?: boolean
  bindings?: readonly Binding[]
  voiceSettingsNotice?: string

  // ADE settings dependencies
  themeState: {
    preference: () => Theme
    set: (t: Theme) => void
    glassOpacity: () => number
    setGlassOpacity: (o: number) => void
  }
  glassStatus?: () => GlassStatus | undefined
  project?: () => { root: string } | undefined
  wb: () => Workbench
  setWb: (fn: (w: Workbench) => Workbench) => void
  hookHost: () => HookHost
  hookStates: () => Record<string, HookStatus>
  refreshHooks: () => void
  openLoginSession: (runner: Runner) => void
  keysHost: () => KeysHost | undefined
  extensionsIo: () => McpConfigIO | undefined
  pluginRuntime: ReturnType<typeof createAdePluginRuntime>
  openGuide: (url: string) => void
  openFramePluginPane: (id: string) => void
  askYesNo: (message: string, labels?: { ok?: string; cancel?: string }) => Promise<boolean>

  /** Registrazione: the same workbench functions the `record.*` commands run. */
  record: {
    /** What the workbench will record at. */
    quality: () => RecordQuality
    /** The write behind `record.quality`. */
    onQuality: (next: RecordQuality) => void
    /** Whether takes start with the microphone on. */
    mic: () => boolean
    /** The write behind `record.mic`. */
    onMic: (next: boolean) => void
    /** The folder takes are saved to, or `undefined` when none was chosen. */
    dir: () => string | undefined
    /** The dialog behind `record.folder`. */
    onPickFolder: () => void
    /** The export behind `record.export`. */
    onExport: () => void
  }
  /** Sistema: the check and the dialog the bell and the palette already use. */
  updates: {
    /** Whether the shared check is running. */
    checking: () => boolean
    /** The update the last check found, if any. */
    available: () => { version: string } | undefined
    /** Opens the same `UpdateDialog` a release notice opens. */
    onInstall: () => void
  }
}

/** The voice page a Voce tab shows: `voice/reply` is `reply`, and anything else the first one. */
export function voicePageOf(tab: string): VoiceSettingsPageId {
  const page = tab.startsWith("voice/") ? tab.slice("voice/".length) : ""
  return VOICE_SETTINGS_PAGES.find((candidate) => candidate === page) ?? "mode"
}

/** What the voice's pages read from the sheet, as live getters: the settings change under them. */
function voiceStateProps(props: SettingsSheetProps): VoiceSettingsStateProps {
  return {
    // ADE's Sheet is the dialog: its Escape, focus trap and press outside.
    framed: true,
    get engine() {
      return props.voiceEngine
    },
    get settings() {
      return props.voiceSettings
    },
    onChange: (next) => props.onVoiceSettingsChange(next),
    onClose: () => props.onClose(),
    get shortcutRefusals() {
      return props.shortcutRefusals
    },
    get onOpenVoiceSource() {
      return props.onOpenVoiceSource
    },
    get naturalVoiceError() {
      return props.naturalVoiceError
    },
    get naturalVoiceDownloading() {
      return props.naturalVoiceDownloading
    },
    get onDownloadNaturalVoice() {
      return props.onDownloadNaturalVoice
    },
    get naturalVoiceProgress() {
      return props.naturalVoiceProgress
    },
    get onCancelInstall() {
      return props.onCancelInstall
    },
    get kokoroPack() {
      return props.kokoroPack
    },
    get onInstallKokoro() {
      return props.onInstallKokoro
    },
    get onDeleteKokoro() {
      return props.onDeleteKokoro
    },
    get onTestVoice() {
      return props.onTestVoice
    },
    get maiBlocked() {
      return props.maiBlocked
    },
    get onRetryMai() {
      return props.onRetryMai
    },
    get testIdentity() {
      return props.testIdentity
    },
    get existingBindings() {
      return props.bindings
    },
    get settingsNotice() {
      return props.voiceSettingsNotice
    },
  }
}

/**
 * The Voce category's body: the voice's status bar, then the open tab's page.
 *
 * One state for every tab, made when Voce opens: a chord half recorded or a
 * «Ripristina la voce» armed survives a look at another tab. «Avvia ascolto»
 * is the footer's (`VoiceListenButton`), and none of the three is drawn in any
 * other category.
 */
function VoiceCategory(props: { sheet: SettingsSheetProps; tab: () => string }): JSX.Element {
  const stateProps = voiceStateProps(props.sheet)
  const state = createVoiceSettingsState(stateProps)
  return (
    <>
      <VoiceStatusBar state={state} />
      <VoiceSettingsPage {...stateProps} state={state} page={voicePageOf(props.tab())} bare />
    </>
  )
}

export function SettingsSheet(props: SettingsSheetProps): JSX.Element {
  const renderContent = (category: CategoryId, tab: string): JSX.Element => {
    switch (category) {
      case "voice":
        // The shell mounts Voce through `renderVoice`; this is its body all the same.
        return <VoiceCategory sheet={props} tab={() => tab} />

      case "general":
        if (tab === "general/language") {
          return <LanguageSection />
        }
        if (tab === "general/grid") {
          return (
            <GridSection
              columns={props.wb().pinnedColumns}
              onChange={(columns) => props.setWb((w) => setColumns(w, columns))}
            />
          )
        }
        return (
          <ThemeSection
            value={props.themeState.preference}
            onChange={(next) => props.themeState.set(next)}
            opacity={props.themeState.glassOpacity}
            onOpacityChange={(val) => props.themeState.setGlassOpacity(val)}
            glassStatus={props.glassStatus}
          />
        )

      case "agents":
        if (tab === "agents/keys") {
          return <KeysSection host={props.keysHost()} agents={AGENTS} />
        }
        if (tab === "agents/bots") {
          return (
            <>
              <BotSection {...(props.project?.()?.root ? { projectRoot: props.project?.()!.root } : {})} />
              <SkillsSection {...(props.project?.()?.root ? { projectRoot: props.project?.()!.root } : {})} />
            </>
          )
        }
        if (tab === "agents/resume") {
          return (
            <AgentHooksSection
              host={props.hookHost()}
              states={props.hookStates()}
              onChanged={() => void props.refreshHooks()}
            />
          )
        }
        return <AccountSection onLogin={(runner) => props.openLoginSession(runner)} />

      case "extensions":
        return (
          <ExtensionsPage
            view={tab === "extensions/installed" ? "installati" : tab === "extensions/plugins" ? "plugin" : "catalogo"}
            projectRoot={props.project?.()?.root}
            io={props.extensionsIo()}
            pluginCount={props.pluginRuntime.registry.sections().length}
            onOpenGuide={(url: string) => props.openGuide(url)}
            plugins={() => (
              <>
                <Show
                  when={props.pluginRuntime.registry.sections().length > 0}
                  fallback={<p data-slot="section-desc">{t("settings.noPlugins")}</p>}
                >
                  <For each={props.pluginRuntime.registry.sections()}>
                    {(section) => <PluginSection title={section.title} render={() => section.render({})} />}
                  </For>
                </Show>
                <Suspense>
                  <FramePluginRows host={getHost} onOpen={(id: string) => void props.openFramePluginPane(id)} />
                </Suspense>
              </>
            )}
          />
        )

      case "record":
        return <RecordVideoSection {...props.record} />

      case "system":
        if (tab === "system/space") {
          return (
            <Suspense>
              <SpaceSection
                host={getHost}
                roots={() => (props.project?.()?.root ? [props.project?.()!.root] : [])}
                openWorktrees={() => props.wb().panes.flatMap((pane) => (pane.worktree ? [pane.worktree] : []))}
                ask={(message) =>
                  props.askYesNo(message, { ok: t("space.remove"), cancel: t("window.closeConfirm.cancel") })
                }
                now={Date.now}
              />
            </Suspense>
          )
        }
        return (
          <UpdatesSection
            version={props.version}
            checking={props.updates.checking}
            available={props.updates.available}
            onCheck={() => props.onCheckUpdates?.()}
            onInstall={() => props.updates.onInstall()}
          />
        )
    }
  }

  return (
    <SettingsShell
      initialTarget={props.initialTarget}
      onClose={props.onClose}
      version={props.version}
      onCheckUpdates={props.onCheckUpdates}
      renderContent={renderContent}
      renderVoice={(tab) => <VoiceCategory sheet={props} tab={tab} />}
      footerExtra={(category) => (category === "voice" ? <VoiceListenButton engine={props.voiceEngine} /> : undefined)}
    />
  )
}
