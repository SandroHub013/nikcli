import { lazy, For, Show, Suspense, type JSX } from "solid-js"
import {
  VoiceSettingsPanel,
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
  ProviderSection,
  RecordVideoSection,
  SkillsSection,
  ThemeSection,
  UpdatesSection,
} from "./sections"
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

function voiceSectionForTab(tab: string): string {
  switch (tab) {
    case "voice/mode":
      return "voice-sec-mode"
    case "voice/activation":
      return "voice-sec-activation"
    case "voice/shortcuts":
      return "voice-sec-shortcuts"
    case "voice/language":
      return "voice-sec-language"
    case "voice/devices":
      return "voice-sec-devices"
    case "voice/recognition":
    case "voice/reply":
      return "voice-sec-backend"
    case "voice/commands":
      return "voice-sec-commands"
    default:
      return "voice-sec-mode"
  }
}

export function SettingsSheet(props: SettingsSheetProps): JSX.Element {
  const renderContent = (category: CategoryId, tab: string): JSX.Element => {
    switch (category) {
      case "voice":
        return (
          <VoiceSettingsPanel
            framed
            engine={props.voiceEngine}
            settings={props.voiceSettings}
            initialSection={voiceSectionForTab(tab)}
            shortcutRefusals={props.shortcutRefusals}
            onChange={props.onVoiceSettingsChange}
            onClose={props.onClose}
            onOpenVoiceSource={props.onOpenVoiceSource}
            naturalVoiceError={props.naturalVoiceError}
            naturalVoiceDownloading={props.naturalVoiceDownloading}
            onDownloadNaturalVoice={props.onDownloadNaturalVoice}
            {...(props.naturalVoiceProgress ? { naturalVoiceProgress: props.naturalVoiceProgress } : {})}
            onCancelInstall={props.onCancelInstall}
            kokoroPack={props.kokoroPack}
            onInstallKokoro={props.onInstallKokoro}
            onDeleteKokoro={props.onDeleteKokoro}
            onTestVoice={props.onTestVoice}
            {...(props.maiBlocked ? { maiBlocked: props.maiBlocked } : {})}
            onRetryMai={props.onRetryMai}
            testIdentity={props.testIdentity}
            existingBindings={props.bindings}
            settingsNotice={props.voiceSettingsNotice}
            title={t("settings.title")}
            subtitle={t("settings.category.voice.desc")}
          />
        )

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
        return <ProviderSection onLogin={(runner) => props.openLoginSession(runner)} />

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
    />
  )
}
