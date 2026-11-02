/**
 * What the app needs from the voice package before anyone has turned the voice on.
 *
 * ADE's first screen reads the voice's settings, draws its orb and answers its
 * chords, and none of that needs the engine: the engine (the dialogue, the
 * speech recognition, the speakers, the Effect runtime) is most of this package
 * and is only worth loading when the microphone is asked for. So the app takes
 * the package through two doors. This one is imported statically and holds only
 * modules whose imports stay among the settings, the chords and the components
 * of the bar; `@ragu/voice` (and `@ragu/voice/core`) is imported with `import()`
 * at the moment the voice is first used.
 *
 * The rule for a name to be here: nothing it imports, transitively, may be the
 * engine, a speaker, a transcriber, an audio capture or `effect`.
 * `light.test.ts` pins that by reading the imports, so a name added here that
 * pulls the engine in is a red test and not a megabyte in the first load.
 */

// The settings: their shape, their storage, the rules about them
export { DEFAULT_VOICE_SETTINGS, holdsToTalk, shortcutActivationEnabled, wakeWordEnabled } from "./settings/model"
export type { ReplyVoice, VoiceActivation, VoiceMode, VoiceSettings } from "./settings/model"
export {
  clearLegacyOpenRouterKey,
  clearOpenRouterKeyRemoved,
  isOpenRouterKeyRemoved,
  loadVoiceSettings,
  markOpenRouterKeyRemoved,
  readLegacyOpenRouterKey,
  saveVoiceSettings,
} from "./settings/storage"

// Which voice reads a reply, and in which language
export {
  activeReplyVoice,
  g2pLocale,
  interfaceLocale,
  isKokoroVoice,
  isMaiVoice,
  kokoroVoice,
  localReplyVoice,
  maiReplyVoice,
  replyLocale,
  speakingReplyVoice,
} from "./settings/reply-voices"
export { KOKORO_DOWNLOAD_BYTES, watchInstall } from "./settings/voice-pack"
export type { InstallProgress, LocalProvider, PackState, PackStatus } from "./settings/voice-pack"

// The chords
export {
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
  describeShortcut,
  findVoiceShortcutConflicts,
  isSystemChord,
  isWindowsRuntime,
  summarizeVoiceShortcutConflicts,
} from "./settings/shortcuts"

// Small pieces the host side names
export { PLANNER_SYSTEM } from "./plan/planner"
export { STT_STREAM_CANCELLED } from "./asr/stream-cancelled"
export { createPlaybackMeter, wavEnvelope } from "./tts/playback-level"
export { createFakeSpeaker, createWebSpeechSpeaker } from "./tts/speaker"
export { groupIntoTurns } from "./agent/log"
export { dropLegacyParakeet } from "./asr/legacy-parakeet"

// The components of the bar and of the agent view: they read an engine through its signals and load nothing of it
export { VoiceOrb } from "./ui/voice-orb"
export { ListeningIndicator } from "./ui/listening-indicator"
export { VoiceHud } from "./ui/voice-hud"
export { AgentOrb } from "./ui/agent-orb"
export { HowItWorks } from "./ui/how-it-works"
