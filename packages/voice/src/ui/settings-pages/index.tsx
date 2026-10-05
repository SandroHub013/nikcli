import { Show, type JSX } from "solid-js"
import { createVoiceSettingsState, type VoiceSettingsState, type VoiceSettingsStateProps } from "../settings-state"
import { ActivationPage } from "./activation"
import { CommandsPage } from "./commands"
import { DevicesPage } from "./devices"
import { LanguagePage } from "./language"
import { ModePage } from "./mode"
import { RecognitionPage } from "./recognition"
import { ReplyPage } from "./reply"
import { ShortcutsPage } from "./shortcuts"
import "../voice-settings.css"

/** The voice's pages, one per tab of ADE's Voce category. */
export const VOICE_SETTINGS_PAGES = [
  "mode",
  "activation",
  "shortcuts",
  "language",
  "devices",
  "recognition",
  "reply",
  "commands",
] as const

export type VoiceSettingsPageId = (typeof VOICE_SETTINGS_PAGES)[number]

/** The element id each page's section has: the old `voice-sec-*`, so links into the panel keep working. */
export const VOICE_PAGE_SECTION: Readonly<Record<VoiceSettingsPageId, string>> = {
  mode: "voice-sec-mode",
  activation: "voice-sec-activation",
  shortcuts: "voice-sec-shortcuts",
  language: "voice-sec-language",
  devices: "voice-sec-devices",
  recognition: "voice-sec-backend",
  reply: "voice-sec-reply",
  commands: "voice-sec-commands",
}

/** The id of the title each page's controls are labelled by. */
export const VOICE_PAGE_TITLE: Readonly<Record<VoiceSettingsPageId, string>> = {
  mode: "section-mode-title",
  activation: "section-activation-title",
  shortcuts: "section-shortcuts-title",
  language: "section-language-title",
  devices: "section-devices-title",
  recognition: "section-backend-title",
  reply: "section-reply-title",
  commands: "section-commands-title",
}

/** One page's content, without a section around it: the panel and `VoiceSettingsPage` add their own. */
export function VoicePageContent(p: { page: VoiceSettingsPageId; state: VoiceSettingsState; bare?: boolean }) {
  // Read once: the panel draws each page once, and ADE mounts a new one per tab.
  switch (p.page) {
    case "mode":
      return <ModePage state={p.state} bare={p.bare} />
    case "activation":
      return <ActivationPage state={p.state} bare={p.bare} />
    case "shortcuts":
      return <ShortcutsPage state={p.state} bare={p.bare} />
    case "language":
      return <LanguagePage state={p.state} bare={p.bare} />
    case "devices":
      return <DevicesPage state={p.state} bare={p.bare} />
    case "recognition":
      return <RecognitionPage state={p.state} bare={p.bare} />
    case "reply":
      return <ReplyPage state={p.state} bare={p.bare} />
    case "commands":
      return <CommandsPage state={p.state} bare={p.bare} />
  }
}

export interface VoiceSettingsPageProps extends VoiceSettingsStateProps {
  page: VoiceSettingsPageId
  /** The state shared with the other pages and the status bar; built here when absent. */
  state?: VoiceSettingsState
  /** Inside a host that names the page already (ADE's tab bar): no visible title. */
  bare?: boolean
}

/**
 * One page of the voice settings, without the panel around it.
 *
 * No header, rail, console or footer: ADE's settings draw those, and draw the
 * voice's status bar and «Avvia ascolto» only in its Voce category.
 */
export function VoiceSettingsPage(props: VoiceSettingsPageProps): JSX.Element {
  const state = props.state ?? createVoiceSettingsState(props)
  return (
    <div
      data-component="voice-settings-panel"
      data-embedded="true"
      data-part="page"
      data-status={state.engineStatus().tone}
    >
      <Show when={props.page} keyed>
        {(page) => (
          <section
            id={VOICE_PAGE_SECTION[page]}
            data-slot="section"
            data-page={page}
            aria-labelledby={VOICE_PAGE_TITLE[page]}
          >
            <VoicePageContent page={page} state={state} bare={props.bare} />
          </section>
        )}
      </Show>
    </div>
  )
}
