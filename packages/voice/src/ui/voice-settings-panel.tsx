/**
 * Voice settings control panel component.
 *
 * Provides a fully accessible, keyboard-operable interface for configuring
 * operational modes, trigger activations, shortcut chords, languages,
 * and recognition backends — plus a live console that exercises the engine
 * without leaving the panel.
 *
 * Guarantees:
 * - Does not perform its own validation or persistence; bubbles changes via props.onChange.
 * - Adheres strictly to ADE design tokens and reduced motion preferences.
 * - Protects OpenRouter API credentials from cleartext rendering.
 * - Every control is reachable and operable from the keyboard alone: radio groups
 *   answer to arrows/Home/End, text fields commit on Enter and revert on Escape.
 * - Strictly typed without type assertions or compiler suppression annotations.
 *
 * Since S5 of the settings rework this is a wrapper: the pages are
 * `settings-pages/*`, their shared state is `settings-state.ts`, and the
 * header and console are drawn from the same pieces ADE uses
 * (`settings-pages/status.tsx`). It stays for the voice used on its own and
 * for the tests that open it whole.
 */

import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import type { VoiceSettings } from "../settings/model"
import { VOCABULARY } from "../intent/vocabulary"
import { createVoiceSettingsState, type VoiceSettingsStateProps } from "./settings-state"
import { VOICE_PAGE_TITLE, VoicePageContent, type VoiceSettingsPageId } from "./settings-pages"
import { ListenActions, MicMark, ResetVoiceButton, StatusPill } from "./settings-pages/status"
import "./voice-settings.css"
import { t } from "@nikcli-ai/ade/i18n"

export interface VoiceSettingsPanelProps extends VoiceSettingsStateProps {
  /** Title shown in the header. Defaults to the voice-only wording. */
  title?: string
  /** The line under the title. Defaults to a description of the voice screens. */
  subtitle?: string
  /** Optional additional CSS class names. */
  class?: string
  /** Optional initial section ID to activate when opening the panel. */
  initialSection?: string
}

/**
 * The panel's own table of contents, in render order.
 *
 * Kept as data rather than as markup so the rail and the sections read from
 * one list and cannot drift apart.
 *
 * These were numbered steps once, shown above a single scroller that held all
 * six at once. They were never a sequence — nobody configures a language
 * before an engine because the engine came fifth — and numbering them said
 * they were. In a rail they are places, so each one carries a glyph and the
 * value it currently holds instead: the rail then answers "what is this set
 * to?" without opening anything, which is the question asked most often and
 * the one the old layout charged three screens of scrolling to answer.
 */
const SECTIONS: readonly {
  id: string
  page: VoiceSettingsPageId
  readonly label: string
  glyph: string
  value: (settings: VoiceSettings) => string
}[] = [
  {
    id: "voice-sec-mode",
    page: "mode",
    get label() {
      return t("vui.rail.mode")
    },
    glyph: "◉",
    value: (s) => (s.mode === "agent" ? t("vui.rail.mode.agent") : t("vui.rail.mode.transcription")),
  },
  {
    id: "voice-sec-activation",
    page: "activation",
    get label() {
      return t("vui.rail.activation")
    },
    glyph: "⌁",
    value: (s) =>
      s.activation === "push-to-talk"
        ? t("vui.rail.activation.push")
        : s.activation === "toggle"
          ? t("vui.rail.activation.toggle")
          : t("vui.rail.activation.wake"),
  },
  {
    id: "voice-sec-shortcuts",
    page: "shortcuts",
    get label() {
      return t("vui.rail.shortcuts")
    },
    glyph: "⌨",
    // Two chords, always: the count is here to keep the column even, not to
    // report a number that varies.
    value: () => "2",
  },
  {
    id: "voice-sec-language",
    page: "language",
    get label() {
      return t("vui.rail.language")
    },
    glyph: "✱",
    value: (s) => s.language,
  },
  {
    id: "voice-sec-devices",
    page: "devices",
    label: "Audio",
    glyph: "⊙",
    /* Which of the two has been moved off the default, rather than a device
       name: the rail is one short column and a device is called things like
       "Microfono (2- Realtek(R) Audio)". */
    value: (s) =>
      s.inputDeviceId ? (s.outputDeviceId ? "2" : "1") : s.outputDeviceId ? "1" : t("vui.rail.devices.system"),
  },
  {
    id: "voice-sec-backend",
    page: "recognition",
    get label() {
      return t("vui.rail.engine")
    },
    glyph: "◆",
    value: (s) => (s.backend === "openrouter" ? "mai2" : s.backend),
  },
  {
    id: "voice-sec-reply",
    page: "reply",
    get label() {
      return t("vui.rail.reply")
    },
    glyph: "♪",
    value: (s) => s.replyVoice,
  },
  {
    id: "voice-sec-commands",
    page: "commands",
    get label() {
      return t("vui.rail.commands")
    },
    glyph: "≡",
    value: () => String(VOCABULARY.length),
  },
]

/**
 * Fixed silhouette for the level meter.
 *
 * A single amplitude drives every bar, so without a per-bar weight the meter
 * would rise and fall as one solid block. These weights give it the shape of a
 * voice without pretending to be a spectrum it never measured.
 */
const METER_WEIGHTS: readonly number[] = [
  0.28, 0.48, 0.7, 0.92, 0.66, 0.86, 1.0, 0.78, 0.94, 0.6, 0.88, 0.72, 0.5, 0.82, 0.4, 0.24,
]

export function VoiceSettingsPanel(props: VoiceSettingsPanelProps) {
  let panelRef: HTMLDivElement | undefined
  const state = createVoiceSettingsState(props, { panelRef: () => panelRef })
  const { frame, engineRunning, engineStatus, micLevel, liveLine } = state
  const [activeSection, setActiveSection] = createSignal(props.initialSection ?? SECTIONS[0].id)
  createEffect(() => {
    if (props.initialSection) {
      setActiveSection(props.initialSection)
    }
  })

  onMount(() => {
    // Framed, the host's dialog takes the focus.
    if (frame() === "standalone" && panelRef) {
      panelRef.focus()
    }
  })

  /**
   * Opens a section from the rail.
   *
   * There is no scrolling to do any more, so this only swaps which section is
   * shown — but the heading still takes focus. Without that the caret would
   * stay on the rail button while the whole page beside it changed, which for
   * anyone reading by screen reader is a change with no announcement, and for
   * anyone tabbing is a jump backwards through the panel.
   */
  const goToSection = (id: string) => {
    setActiveSection(id)
    queueMicrotask(() => {
      const heading = document.getElementById(id)?.querySelector<HTMLElement>('[data-slot="section-title"]')
      heading?.focus()
    })
  }

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && props.onClose) {
      props.onClose()
    }
  }

  // Render main panel contents
  const renderPanel = () => (
    <div
      ref={panelRef}
      data-component="voice-settings-panel"
      data-inline={props.inline ? "true" : undefined}
      data-status={engineStatus().tone}
      class={props.class}
      // Framed, the host's dialog is the dialog, named by this panel's title.
      role={frame() === "standalone" ? "dialog" : frame() === "inline" ? "region" : undefined}
      aria-modal={frame() === "standalone" ? "true" : undefined}
      aria-labelledby={frame() === "framed" ? undefined : "voice-panel-title"}
      tabIndex={frame() === "standalone" ? -1 : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div data-slot="header">
        <MicMark state={state} />

        <div data-slot="header-info">
          {/* Named by the host when the host has put more than voice in it:
              a panel that says "vocale" while showing the plugin list is
              telling the user they are in the wrong place. */}
          <h2 id="voice-panel-title" data-slot="title">
            {props.title ?? t("vui.panel.title")}
          </h2>
          {/* The same reasoning as the title, for the line under it: it used
              to list the voice sections, which with six of the host's own
              beside them described a third of the panel. */}
          <p data-slot="subtitle">{props.subtitle ?? t("vui.panel.subtitle")}</p>
        </div>

        <StatusPill state={state} />

        {/*
         * The voice's own header, not the rail: it resets DEFAULT_VOICE_SETTINGS
         * and nothing else, the transcription engine included, which comes back
         * on `openrouter`. Beside the title it says what it resets.
         */}
        <ResetVoiceButton state={state} />

        <Show when={!props.inline && props.onClose}>
          <button type="button" data-slot="close-btn" aria-label={t("vui.panel.close")} onClick={props.onClose}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Show>
      </div>

      {/*
        Rail and page, side by side.

        One section is on screen at a time, at the full width of the panel.
        What it replaced was a single scroller holding all six, which meant the
        panel was as tall as its longest section plus the other five — taller
        than the window it opened in — and reaching the engine list cost about
        three screens of scrolling.
      */}
      <div data-slot="shell">
        <nav data-slot="rail" aria-label={t("vui.panel.sections")}>
          <For each={SECTIONS}>
            {(section) => (
              <button
                type="button"
                data-slot="rail-row"
                data-current={activeSection() === section.id ? "true" : undefined}
                aria-current={activeSection() === section.id ? "page" : undefined}
                onClick={() => goToSection(section.id)}
              >
                <span data-slot="rail-glyph" aria-hidden="true">
                  {section.glyph}
                </span>
                <span data-slot="rail-label">{section.label}</span>
                {/* The current value, so the rail is a summary and not just a
                    menu: most visits here are to check a setting, not change one. */}
                <span data-slot="rail-value">{section.value(props.settings)}</span>
              </button>
            )}
          </For>
        </nav>

        {/* Body */}
        <div data-slot="body">
          <For each={SECTIONS}>
            {(section) => (
              <section
                id={section.id}
                data-slot="section"
                data-hidden={activeSection() === section.id ? undefined : "true"}
                aria-labelledby={VOICE_PAGE_TITLE[section.page]}
              >
                <VoicePageContent page={section.page} state={state} />
              </section>
            )}
          </For>
        </div>
      </div>

      {/*
        The live console, under both columns.

        It used to sit above the sections, which meant that testing the mic
        after changing the engine — the one thing anybody wants to do after
        changing the engine — required scrolling back to the top. Down here it
        spans the panel and stays put whichever section is open.
      */}
      <div data-slot="live" data-running={engineRunning() ? "true" : undefined}>
        <div data-slot="meter" aria-hidden="true">
          <For each={METER_WEIGHTS}>
            {(weight, index) => (
              <span
                data-slot="meter-bar"
                style={{
                  height: `${engineRunning() ? 14 + Math.min(micLevel() * 2.2, 1) * weight * 86 : 16 + weight * 10}%`,
                  "animation-delay": `${index() * 45}ms`,
                }}
              />
            )}
          </For>
        </div>

        <div data-slot="live-text">
          <p data-slot="live-line" data-kind={liveLine().kind}>
            {liveLine().text}
          </p>
          <Show when={props.engine.lastError()}>
            <p data-slot="live-error" role="alert">
              {props.engine.lastError()}
            </p>
          </Show>
        </div>

        <div data-slot="live-actions">
          <ListenActions engine={props.engine} />
        </div>
      </div>

      {/* Footer */}
      <div data-slot="footer">
        <span data-slot="footer-hint">{t("vui.footer.keys")}</span>
        <Show when={!props.inline && props.onClose}>
          <button type="button" data-slot="solid-btn" onClick={props.onClose}>
            {t("vui.footer.done")}
          </button>
        </Show>
      </div>
    </div>
  )

  return (
    <Show when={frame() === "standalone"} fallback={renderPanel()}>
      <div data-component="voice-settings-overlay" onClick={handleBackdropClick}>
        {renderPanel()}
      </div>
    </Show>
  )
}
