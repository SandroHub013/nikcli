/**
 * The voice settings' state, shared by every page of them.
 *
 * The pages used to be one 2400-line component, so the signals they share —
 * the chord being recorded, the armed «Ripristina la voce», the filters, the
 * key being typed — lived in its closure. ADE now draws the pages one tab at a
 * time inside its own settings, and the standalone panel draws all of them:
 * both build this once and hand it to the pages, so a page never owns a signal
 * another page reads.
 *
 * Also here, because it is state and not layout: the keyboard listener that
 * stops a chord recording or disarms the reset on Escape before the host's
 * dialog closes under it.
 */

import {
  activeReplyVoice,
  backendOf,
  REPLY_BACKEND_CHOICES,
  replyVoiceChoicesFor,
  voiceOnBackend,
  rememberReplyVoice,
  acceptMaiVoice,
} from "../settings/reply-voices"
import type { MaiPanelInput } from "./mai-panel"
import type { StreamPanelInput } from "./stream-panel"
import type { StreamState } from "../asr/grok-stream"
import type { MaiFailureKind } from "../tts/mai"
import { packView, type InstallProgress, type LocalProvider, type PackState } from "../settings/voice-pack"
import { panelEscape, panelFrame, panelListensEarly, panelTrapsTab } from "./panel-keys"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { VoiceEngine } from "../engine"
import type { DialogStatus } from "../dialog/session"
import {
  DEFAULT_VOICE_SETTINGS,
  wakeWordEnabled,
  shortcutActivationEnabled,
  type AgentEngine,
  type AgentSpeed,
  type ReplyVoice,
  type TranscriptionSendMode,
  type VoiceActivation,
  type VoiceMode,
  type VoiceSettings,
} from "../settings/model"
import { availableLanguages, isLanguageSupported, type LanguageOption } from "../settings/languages"
import { VOICE_COMMAND_AGENT, VOICE_COMMAND_TRANSCRIPTION } from "../settings/shortcuts"
import { describeBackends, type TranscriberBackend } from "../asr/select"
import { listAudioDevices, onDeviceChange, SYSTEM_DEFAULT, type AudioDevices } from "../audio/devices"
import { VOCABULARY } from "../intent/vocabulary"
import type { Binding } from "@nikcli-ai/ade/keyboard/keymap"
import { captureKeyboardEvent, checkShortcutConflict, getPlatform, suggestClosestLanguage } from "./shortcut-capture"
import { submitVoiceTrial } from "./voice-trial"
import { locale, t } from "@nikcli-ai/ade/i18n"

/** What the pages need from their host: the settings, the engine, and the host's voice actions. */
export interface VoiceSettingsStateProps {
  /** The voice control engine instance. */
  engine: VoiceEngine
  /** Current voice settings. */
  settings: VoiceSettings
  /** Upward notification callback fired when any configuration setting changes. */
  onChange: (next: VoiceSettings) => void
  /** Optional callback fired when the panel requests closing. */
  onClose?: () => void
  /**
   * What changed under the user in this profile, shown where they can undo it.
   *
   * The startup strip says it once and is dismissed; a rule that changed how
   * the microphone answers has to be readable next to the switch that turns
   * it back, or the only way to find out is to wonder why nothing replies.
   */
  settingsNotice?: string
  /** Optional existing ADE keymap bindings to evaluate for shortcut collision. */
  existingBindings?: readonly Binding[]
  /**
   * The chords the system would not register, each with what to say: another
   * application holds it. Shown beside the chord, because a refused one looks
   * exactly like one that works until it is pressed and nothing happens.
   */
  shortcutRefusals?: { agent?: string; transcription?: string }
  /** Opens the page of a Piper voice's model, where its licence is stated. Absent: no link is shown. */
  onOpenVoiceSource?: (voice: ReplyVoice) => void
  naturalVoiceError?: string
  naturalVoiceDownloading?: boolean
  onDownloadNaturalVoice?: () => void
  /** How the Piper download is going, while it goes (K3's `tts_install_status`). */
  naturalVoiceProgress?: InstallProgress
  /** Stops the install under way for a provider (K3's `tts_install_cancel`). Absent: no cancel is shown. */
  onCancelInstall?: (provider: LocalProvider) => void
  /** The Kokoro pack as the host reports it (K6). Its `status` is absent where the host cannot run Kokoro. */
  kokoroPack?: PackState
  onInstallKokoro?: () => void
  onDeleteKokoro?: () => void
  /** Speaks a short sample in the voice chosen. Absent: no button. */
  onTestVoice?: () => void
  /** Why the MAI speaker is not asking MAI right now, as it last said; undefined when it is. */
  maiBlocked?: MaiFailureKind
  /** The panel's «Riprova MAI»: opens the breaker, and asks nothing until a sentence needs it. */
  onRetryMai?: () => void
  /** Opens the host's page for keys (ADE's Chiavi API), where the OpenRouter key is managed. Absent: no link. */
  onManageKeys?: () => void
  /**
   * The xAI key as the host's keychain shows it (`••••abcd`), `null` without one.
   * Absent: the host cannot tell, and the page says nothing about the key.
   */
  xaiKeyMasked?: string | null
  /** Why the open transcriber is or is not streaming, as it last said. */
  streamState?: StreamState
  /** «Riprova lo streaming»: clears a refusal or a pause. Absent: no button. */
  onRetryStream?: () => void
  /** ADE Test: MAI is never used, and its question is never asked. */
  testIdentity?: boolean
  /** Optional cost of the most recent speech transcription request. */
  lastCost?: number
  /** Whether the panel is rendered as a standalone inline component rather than an overlay dialog. */
  inline?: boolean
  /**
   * The host draws the dialog around the pages (ADE's Sheet): its overlay,
   * focus trap, Escape and press outside are the host's. See `panel-keys.ts`.
   */
  framed?: boolean
}

export interface StatusDescriptor {
  label: string
  tone: "off" | "ready" | "live" | "warn" | "busy"
  detail: string
}

export function describeStatus(status: DialogStatus, running: boolean): StatusDescriptor {
  if (!running) {
    return {
      label: t("vui.status.off"),
      tone: "off",
      detail: t("vui.status.off.detail"),
    }
  }
  switch (status) {
    case "asleep":
      return {
        label: t("vui.status.asleep"),
        tone: "warn",
        detail: t("vui.status.asleep.detail"),
      }
    case "idle":
      return { label: t("vui.status.idle"), tone: "ready", detail: t("vui.status.idle.detail") }
    case "listening":
      return { label: t("vui.status.listening"), tone: "live", detail: t("vui.status.listening.detail") }
    case "confirming":
      return {
        label: t("vui.status.confirming"),
        tone: "warn",
        detail: t("vui.status.confirming.detail"),
      }
    case "dictating":
      return {
        label: t("vui.status.dictating"),
        tone: "live",
        detail: t("vui.status.dictating.detail"),
      }
    case "executing":
      return { label: t("vui.status.executing"), tone: "busy", detail: t("vui.status.executing.detail") }
  }
}

/**
 * Selects the radio addressed by a keyboard event inside one radio group.
 *
 * Arrow keys move and select in the same motion, which is what a radio group is
 * specified to do; Home and End jump to the ends. Radios belonging to a nested
 * group are excluded so the engine pills never steal the backend list's arrows.
 */
export function radioGroupKeys(apply: (value: string) => void) {
  return (event: KeyboardEvent) => {
    const group = event.currentTarget
    if (!(group instanceof HTMLElement)) return
    const origin = event.target
    if (!(origin instanceof HTMLElement)) return
    const radio = origin.closest<HTMLElement>('[role="radio"]')
    // A radio belonging to a nested group (the engine pills) is that group's
    // business: swallowing its keys here would leave it unusable.
    if (!radio || radio.closest('[role="radiogroup"]') !== group) return

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      if (radio.getAttribute("aria-disabled") !== "true") {
        const value = radio.getAttribute("data-value")
        if (value) apply(value)
      }
      return
    }

    const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
    if (!forward && !backward && event.key !== "Home" && event.key !== "End") return

    const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
      (candidate) =>
        candidate.closest('[role="radiogroup"]') === group && candidate.getAttribute("aria-disabled") !== "true",
    )
    if (radios.length === 0) return

    event.preventDefault()
    const index = radios.indexOf(radio)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : forward
            ? (index + 1 + radios.length) % radios.length
            : (index - 1 + radios.length) % radios.length

    const target = radios[next]
    target.focus()
    const value = target.getAttribute("data-value")
    if (value) apply(value)
  }
}

export interface VoiceSettingsStateOptions {
  /** The standalone panel's element, for its own Tab trap. */
  panelRef?: () => HTMLElement | undefined
}

export function createVoiceSettingsState(props: VoiceSettingsStateProps, options: VoiceSettingsStateOptions = {}) {
  const frame = () => panelFrame(props)
  const panelRef = () => options.panelRef?.()
  const platform = getPlatform()

  // Active shortcut recording state
  const [recordingField, setRecordingField] = createSignal<"agent" | "transcription" | null>(null)
  const [agentConflict, setAgentConflict] = createSignal<string | null>(null)
  const [transcriptionConflict, setTranscriptionConflict] = createSignal<string | null>(null)
  /*
   * A chord that was accepted but comes with a caveat — a Win-key combination
   * the OS may swallow, an Alt+letter the window menu may claim. Kept apart
   * from the conflict signals because it does not block the save: refusing
   * these outright would forbid chords that work fine on plenty of machines.
   */
  const [agentWarning, setAgentWarning] = createSignal<string | null>(null)
  const [transcriptionWarning, setTranscriptionWarning] = createSignal<string | null>(null)
  /*
   * The modifiers held down so far, while the chord is still incomplete.
   *
   * Without this the recorder showed its "press keys" prompt and then nothing at all
   * until a full chord landed, so holding Ctrl+Shift and hesitating looked
   * exactly like a recorder that had stopped listening.
   */
  const [pendingModifiers, setPendingModifiers] = createSignal<readonly string[]>([])

  // Local input states for language filter and command trial
  const [languageFilter, setLanguageFilter] = createSignal("")
  const [commandFilter, setCommandFilter] = createSignal("")
  const [trialText, setTrialText] = createSignal("")
  const [trialBusy, setTrialBusy] = createSignal(false)
  const [resetArmed, setResetArmed] = createSignal(false)

  /*
   * The machine's audio hardware, and what is cached of the local model.
   *
   * Both are asked for on mount rather than computed: one is a browser API and
   * the other is IndexedDB, and neither is reactive. The device list is asked
   * for again on `devicechange`, because hardware is hot-pluggable and a list
   * enumerated once at open shows the old headset until the panel is closed.
   */
  const [devices, setDevices] = createSignal<AudioDevices>({
    inputs: [SYSTEM_DEFAULT],
    outputs: [SYSTEM_DEFAULT],
    labelled: false,
  })
  const refreshDevices = () => {
    void listAudioDevices().then(setDevices)
  }
  onMount(() => {
    refreshDevices()
    const stop = onDeviceChange(refreshDevices)
    onCleanup(stop)
  })

  // Backend readiness diagnostics from select.ts
  const backendStatuses = createMemo(() => {
    return describeBackends({
      apiKey: props.settings.openRouterApiKey,
    })
  })

  // Available languages dynamically queried from languages.ts
  const currentLanguages = createMemo<LanguageOption[]>(() => {
    return availableLanguages(props.settings.backend)
  })

  /**
   * The language list narrowed by what has been typed.
   *
   * The selected language is always kept in the list even when it does not
   * match: dropping it would leave the select with no option to show and it
   * would silently display the wrong language.
   */
  const filteredLanguages = createMemo<LanguageOption[]>(() => {
    const query = languageFilter().trim().toLowerCase()
    if (query.length === 0) return currentLanguages()
    return currentLanguages().filter(
      (lang) =>
        lang.code === props.settings.language ||
        lang.code.toLowerCase().includes(query) ||
        lang.label.toLowerCase().includes(query),
    )
  })

  // Check language support for current backend
  const isLangSupported = createMemo(() => {
    return isLanguageSupported(props.settings.backend, props.settings.language)
  })

  // Nearest language recommendation when unsupported
  const langSuggestion = createMemo(() => {
    if (isLangSupported()) return undefined
    return suggestClosestLanguage(props.settings.language, currentLanguages())
  })

  const filteredCommands = createMemo(() => {
    const query = commandFilter().trim().toLowerCase()
    if (query.length === 0) return VOCABULARY
    return VOCABULARY.filter(
      (spec) =>
        spec.intent.toLowerCase().includes(query) ||
        spec.readback.toLowerCase().includes(query) ||
        spec.phrases.some((phrase) => phrase.toLowerCase().includes(query)),
    )
  })

  // Live engine readouts
  const engineRunning = () => props.engine.isRunning()
  const engineStatus = createMemo(() => describeStatus(props.engine.status(), engineRunning()))
  const micLevel = () => props.engine.micLevel()

  const liveLine = createMemo(() => {
    const partial = props.engine.partialTranscript().trim()
    if (partial.length > 0) return { text: partial, kind: "partial" as const }
    const spoken = props.engine.lastSpoken().trim()
    if (engineRunning() && spoken.length > 0) return { text: spoken, kind: "spoken" as const }
    return { text: engineStatus().detail, kind: "hint" as const }
  })

  // Resolve last request cost from props or engine
  const resolvedCost = createMemo<number | undefined>(() => {
    if (typeof props.lastCost === "number") return props.lastCost
    const eng = props.engine as unknown as Record<string, unknown>
    if (typeof eng.lastCost === "function") {
      const res = (eng.lastCost as () => unknown)()
      if (typeof res === "number") return res
    }
    if (typeof eng.lastCost === "number") return eng.lastCost
    if (typeof eng.lastUsage === "function") {
      const usage = (eng.lastUsage as () => unknown)() as { cost?: number } | null | undefined
      if (typeof usage?.cost === "number") return usage.cost
    }
    return undefined
  })

  // Upward change dispatcher
  const updateSettings = (patch: Partial<VoiceSettings>) => {
    props.onChange({
      ...props.settings,
      ...patch,
    })
  }

  /**
   * Wake-word activation only exists for the agent, so a stored pairing of
   * transcription mode with wake-word activation leaves every activation radio
   * unchecked. Repair it once on open rather than rendering an impossible state.
   */
  onMount(() => {
    if (props.settings.mode === "transcription" && props.settings.activation === "wake-word") {
      updateSettings({ activation: DEFAULT_VOICE_SETTINGS.activation })
    }
  })

  const selectMode = (mode: VoiceMode) => {
    if (mode === "transcription" && props.settings.activation === "wake-word") {
      updateSettings({ mode, activation: DEFAULT_VOICE_SETTINGS.activation })
      return
    }
    updateSettings({ mode })
  }

  const selectActivation = (activation: VoiceActivation) => {
    if (activation !== "wake-word" && !shortcutActivationEnabled()) return
    if (activation !== "push-to-talk" && !wakeWordEnabled()) return
    if (activation === "wake-word" && (!wakeWordEnabled() || props.settings.mode !== "agent")) return
    updateSettings({ activation })
  }

  const toggleListening = () => {
    void props.engine.toggle()
  }

  const runTrial = async () => {
    const text = trialText().trim()
    if (text.length === 0 || trialBusy()) return
    setTrialBusy(true)
    try {
      await submitVoiceTrial(props.engine, text)
      setTrialText("")
    } finally {
      setTrialBusy(false)
    }
  }

  const restoreDefaults = () => {
    if (!resetArmed()) {
      setResetArmed(true)
      return
    }
    setResetArmed(false)
    setLanguageFilter("")
    props.onChange({ ...DEFAULT_VOICE_SETTINGS })
  }

  // Global keyboard listener for modal Escape and shortcut recording cancellation
  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const action = panelEscape({
        frame: frame(),
        recording: recordingField() !== null,
        resetArmed: resetArmed(),
        closable: Boolean(props.onClose),
      })
      if (action === "stop-recording") {
        e.preventDefault()
        e.stopPropagation()
        setRecordingField(null)
        setPendingModifiers([])
        setAgentConflict(null)
        setTranscriptionConflict(null)
        return
      }

      if (action === "disarm") {
        e.preventDefault()
        setResetArmed(false)
        return
      }

      if (action === "close") {
        e.preventDefault()
        props.onClose?.()
      }
    }

    // Modal focus trap when rendered as overlay
    if (panelTrapsTab(frame()) && e.key === "Tab" && panelRef()) {
      const focusable = Array.from(
        panelRef()!.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    // Framed: before the host's dialog, which would close under the recorder.
    if (panelListensEarly(frame())) {
      document.addEventListener("keydown", handleGlobalKeyDown, true)
      onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown, true))
      return
    }
    window.addEventListener("keydown", handleGlobalKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleGlobalKeyDown))
  })

  const setFieldConflict = (field: "agent" | "transcription", message: string | null) => {
    if (field === "agent") setAgentConflict(message)
    else setTranscriptionConflict(message)
  }

  const setFieldWarning = (field: "agent" | "transcription", message: string | null) => {
    if (field === "agent") setAgentWarning(message)
    else setTranscriptionWarning(message)
  }

  // Key event handler for shortcut capture fields
  const handleShortcutKeyDown = (field: "agent" | "transcription", e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const result = captureKeyboardEvent(
      {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      },
      platform,
    )

    if (result.type === "cancel") {
      setRecordingField(null)
      setPendingModifiers([])
      setFieldConflict(field, null)
      return
    }

    // Not a chord yet: show what is being held rather than nothing.
    if (result.type === "modifier_only") {
      setPendingModifiers(result.modifiers)
      return
    }

    if (result.type === "ignored") {
      return
    }

    const targetCommand = field === "agent" ? VOICE_COMMAND_AGENT : VOICE_COMMAND_TRANSCRIPTION

    const conflict = checkShortcutConflict(
      result.chord,
      targetCommand,
      props.settings,
      props.existingBindings,
      platform,
    )

    if (conflict.hasConflict) {
      // The recorder stays open so the next attempt needs no second click.
      setPendingModifiers([])
      setFieldConflict(field, conflict.message ?? t("vui.shortcut.conflicting"))
      return
    }

    // Successful capture without collision
    setFieldConflict(field, null)
    setFieldWarning(field, conflict.warning ?? null)
    updateSettings(field === "agent" ? { agentChord: result.chord } : { transcriptionChord: result.chord })
    setRecordingField(null)
    setPendingModifiers([])
  }

  const startRecording = (field: "agent" | "transcription") => {
    setRecordingField(field)
    setPendingModifiers([])
    setFieldConflict(field, null)
    setFieldWarning(field, null)
  }

  const stopRecording = (field: "agent" | "transcription") => {
    if (recordingField() === field) {
      setRecordingField(null)
      setPendingModifiers([])
    }
  }

  const resetChord = (field: "agent" | "transcription") => {
    setFieldConflict(field, null)
    setFieldWarning(field, null)
    updateSettings(
      field === "agent"
        ? { agentChord: DEFAULT_VOICE_SETTINGS.agentChord }
        : { transcriptionChord: DEFAULT_VOICE_SETTINGS.transcriptionChord },
    )
  }

  /**
   * A standing complaint about the chord that is already saved.
   *
   * The recorder refuses a colliding chord, so nothing recorded here can be
   * shadowed — but a profile hand-edited, copied between machines, or written
   * before ADE claimed that chord can hold one anyway, and at runtime ADE wins
   * and the microphone simply never opens. Recomputed from props so it clears
   * itself the moment the chord is changed.
   */
  const storedIssue = (field: "agent" | "transcription") => {
    const chord = field === "agent" ? props.settings.agentChord : props.settings.transcriptionChord
    const target = field === "agent" ? VOICE_COMMAND_AGENT : VOICE_COMMAND_TRANSCRIPTION
    const verdict = checkShortcutConflict(chord, target, props.settings, props.existingBindings, platform)
    if (!verdict.hasConflict) return undefined
    return t("vui.shortcut.shadowed", verdict.message ?? t("vui.shortcut.conflicting"))
  }

  /** The recording attempt's complaint, or the saved chord's, in that order. */
  const shortcutIssue = (field: "agent" | "transcription") =>
    (field === "agent" ? agentConflict() : transcriptionConflict()) ??
    storedIssue(field) ??
    props.shortcutRefusals?.[field]

  /**
   * What the recorder button says while it is listening.
   *
   * The mac glyphs already read as one cluster (⇧⌘), so they are joined with
   * nothing; elsewhere the names need the separator to be legible.
   */
  const recordingLabel = () => {
    const held = pendingModifiers()
    if (held.length === 0) return t("vui.shortcut.recording")
    return `${held.join(platform === "mac" ? "" : "+")}…`
  }

  const modeKeys = radioGroupKeys((value) => selectMode(value as VoiceMode))
  const sendKeys = radioGroupKeys((value) => updateSettings({ transcriptionSend: value as TranscriptionSendMode }))
  const pressKeys = radioGroupKeys((value) =>
    updateSettings({ dictationPress: value === "toggle" ? "toggle" : "hold" }),
  )
  const listenKeys = radioGroupKeys((value) => updateSettings({ alwaysListen: value === "always" }))
  const replyKeys = radioGroupKeys((value) => updateSettings({ speakReplies: value === "speak" }))
  const alertsKeys = radioGroupKeys((value) => updateSettings({ spokenAlerts: value === "on" }))
  /*
   * The voice and its backend are written together: `normalizeSettings`
   * repairs a pair that disagrees, and says so, which a click must not cause.
   */
  const pickReplyVoice = (voice: ReplyVoice) => {
    // The voice left and the one picked are both remembered, each on its backend: coming back finds it.
    const memory = rememberReplyVoice(
      rememberReplyVoice(props.settings.replyVoiceByBackend, props.settings.replyVoice),
      voice,
    )
    updateSettings({
      replyVoice: voice,
      replyBackend: backendOf(voice),
      ...(memory ? { replyVoiceByBackend: memory } : {}),
    })
  }
  const replyVoiceKeys = radioGroupKeys((value) => {
    const choice = replyVoiceChoicesFor(replyBackendNow(), locale()).find((candidate) => candidate.value === value)
    if (choice) pickReplyVoice(choice.value)
  })
  const replyBackendKeys = radioGroupKeys((value) => {
    const backend = REPLY_BACKEND_CHOICES.find((choice) => choice.value === value)?.value
    if (backend)
      pickReplyVoice(voiceOnBackend(backend, props.settings.replyVoice, locale(), props.settings.replyVoiceByBackend))
  })
  /** The backend the chosen voice belongs to: the one whose voices are listed. */
  const replyBackendNow = () => backendOf(props.settings.replyVoice)
  /* MAI, in the OpenRouter card: what it shows is decided in `mai-panel.ts`. */
  const maiInput = (): MaiPanelInput => ({
    replyVoice: props.settings.replyVoice,
    ...(props.settings.replyVoiceOffer ? { replyVoiceOffer: props.settings.replyVoiceOffer } : {}),
    hasKey: Boolean(props.settings.openRouterApiKey),
    testIdentity: props.testIdentity === true,
    ...(props.maiBlocked ? { blocked: props.maiBlocked } : {}),
    spend: props.engine.listenSpend(),
  })
  /* The streaming engine, in Riconoscimento: what it shows is decided in `stream-panel.ts`. */
  const streamInput = (): StreamPanelInput => ({
    backend: props.settings.backend,
    ...(props.xaiKeyMasked !== undefined ? { xaiKey: props.xaiKeyMasked } : {}),
    capUsd: props.settings.streamDailyCapUsd,
    spend: props.engine.listenSpend(),
    ...(props.streamState ? { state: props.streamState } : {}),
    testIdentity: props.testIdentity === true,
    now: Date.now(),
    language: locale(),
  })
  // «Usa» keeps Ugo as the local voice underneath, so the fallback is the voice the profile had.
  const acceptMaiOffer = () =>
    updateSettings({
      ...acceptMaiVoice(),
      replyVoiceByBackend: rememberReplyVoice(props.settings.replyVoiceByBackend, props.settings.replyVoice) ?? {},
    })
  const declineMaiOffer = () => updateSettings({ replyVoiceOffer: "declined" })
  /** The local voice under MAI: remembered on Piper, where `localReplyVoice` looks first. */
  const pickMaiLocal = (voice: ReplyVoice) =>
    updateSettings({ replyVoiceByBackend: rememberReplyVoice(props.settings.replyVoiceByBackend, voice) ?? {} })
  /** The voice marked in the list: a Piper one follows the interface language, as it speaks. */
  const shownReplyVoice = () =>
    replyBackendNow() === "piper" ? activeReplyVoice(props.settings.replyVoice, locale()) : props.settings.replyVoice
  const kokoroView = createMemo(() => packView(props.kokoroPack ?? {}))
  const piperDownload = createMemo(() =>
    props.naturalVoiceProgress
      ? packView({ status: { installed: false }, progress: props.naturalVoiceProgress })
      : undefined,
  )
  /** A Kokoro voice speaks once its pack is in; a Piper one installs itself on first use. */
  const canTestVoice = () => replyBackendNow() !== "kokoro" || kokoroView().canTest
  const engineKeys = radioGroupKeys((value) => updateSettings({ agentEngine: value as AgentEngine }))
  const speedKeys = radioGroupKeys((value) => updateSettings({ agentSpeed: value as AgentSpeed }))
  const fallbackKeys = radioGroupKeys((value) => updateSettings({ codexFallback: value === "on" }))
  const activationKeys = radioGroupKeys((value) => selectActivation(value as VoiceActivation))
  const backendKeys = radioGroupKeys((value) => updateSettings({ backend: value as TranscriberBackend }))

  return {
    props,
    platform,
    frame,
    recordingField,
    agentWarning,
    transcriptionWarning,
    languageFilter,
    setLanguageFilter,
    commandFilter,
    setCommandFilter,
    trialText,
    setTrialText,
    trialBusy,
    resetArmed,
    setResetArmed,
    devices,
    backendStatuses,
    currentLanguages,
    filteredLanguages,
    isLangSupported,
    langSuggestion,
    filteredCommands,
    engineRunning,
    engineStatus,
    micLevel,
    liveLine,
    resolvedCost,
    updateSettings,
    selectMode,
    selectActivation,
    toggleListening,
    runTrial,
    restoreDefaults,
    handleShortcutKeyDown,
    startRecording,
    stopRecording,
    resetChord,
    shortcutIssue,
    recordingLabel,
    modeKeys,
    sendKeys,
    pressKeys,
    listenKeys,
    replyKeys,
    alertsKeys,
    pickReplyVoice,
    replyVoiceKeys,
    replyBackendKeys,
    replyBackendNow,
    maiInput,
    acceptMaiOffer,
    declineMaiOffer,
    pickMaiLocal,
    shownReplyVoice,
    kokoroView,
    piperDownload,
    canTestVoice,
    engineKeys,
    speedKeys,
    fallbackKeys,
    activationKeys,
    backendKeys,
    streamInput,
  }
}

export type VoiceSettingsState = ReturnType<typeof createVoiceSettingsState>
