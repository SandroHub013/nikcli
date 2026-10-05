/** Voce › Lingua parlata: the language spoken to the microphone, not the interface's. */
import { Show, For, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function LanguagePage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const {
    props,
    languageFilter,
    setLanguageFilter,
    currentLanguages,
    filteredLanguages,
    isLangSupported,
    langSuggestion,
    updateSettings,
  } = p.state
  return (
    <>
      <PageHead
        id="section-language-title"
        title={t("vui.language.title")}
        desc={t("vui.language.desc")}
        bare={p.bare}
      />
      <div data-slot="stack">
        <label for="voice-language-filter" data-slot="label">
          {t("vui.language.search")}
        </label>
        <input
          id="voice-language-filter"
          data-slot="input"
          type="search"
          autocomplete="off"
          placeholder={t("vui.language.search.placeholder")}
          value={languageFilter()}
          aria-describedby="voice-language-count"
          onInput={(e) => setLanguageFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              setLanguageFilter("")
              return
            }
            if (e.key === "Enter") {
              e.preventDefault()
              const first = filteredLanguages().find((lang) => lang.code !== props.settings.language)
              if (first) updateSettings({ language: first.code })
            }
          }}
        />

        <label for="voice-language-select" data-slot="label">
          {t("vui.language.select")}
        </label>
        <select
          id="voice-language-select"
          data-slot="select"
          value={props.settings.language}
          onChange={(e) => updateSettings({ language: e.currentTarget.value })}
        >
          <For each={filteredLanguages()}>
            {(lang) => (
              <option value={lang.code}>
                {lang.label} ({lang.code.toUpperCase()})
              </option>
            )}
          </For>
        </select>
        <p id="voice-language-count" data-slot="hint">
          {t("vui.language.count", filteredLanguages().length, currentLanguages().length)}
        </p>
      </div>

      {/* Unsupported language alert and closest language recommendation */}
      <Show when={!isLangSupported()}>
        <div role="alert" data-slot="lang-warning">
          <div data-slot="lang-warning-msg">{t("vui.language.unsupported", props.settings.language)}</div>
          <Show when={langSuggestion()}>
            <button
              type="button"
              data-slot="lang-suggest-btn"
              onClick={() => updateSettings({ language: langSuggestion()!.code })}
            >
              {t("vui.language.switch", `${langSuggestion()?.label} (${langSuggestion()?.code.toUpperCase()})`)}
            </button>
          </Show>
        </div>
      </Show>
    </>
  )
}
