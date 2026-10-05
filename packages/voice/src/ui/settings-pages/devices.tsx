/** Voce › Audio: the microphone and the speaker. */
import { Show, For, type JSX } from "solid-js"
import { t } from "@nikcli-ai/ade/i18n"
import { describeChoice } from "../../audio/devices"
import type { VoiceSettingsState } from "../settings-state"
import { PageHead } from "./head"

export function DevicesPage(p: { state: VoiceSettingsState; bare?: boolean }): JSX.Element {
  const { props, devices, updateSettings } = p.state
  return (
    <>
      <PageHead id="section-devices-title" title={t("vui.audio.title")} desc={t("vui.audio.desc")} bare={p.bare} />
      <div data-slot="stack">
        <label for="voice-input-device" data-slot="label">
          {t("vui.audio.mic")}
        </label>
        <select
          id="voice-input-device"
          data-slot="select"
          value={props.settings.inputDeviceId ?? ""}
          onChange={(e) => updateSettings({ inputDeviceId: e.currentTarget.value || undefined })}
        >
          <For each={devices().inputs}>{(device) => <option value={device.id}>{device.label}</option>}</For>
        </select>
        <p data-slot="hint">
          {/*
          Said, because the alternative is a picker full of "Microfono 1"
          and "Microfono 2" with no way to tell which is which: the
          browser withholds device names until the microphone has been
          granted once, and that is a fact about permission rather than
          about the hardware.
        */}
          <Show when={devices().labelled} fallback={<>{t("vui.audio.unlabelled")}</>}>
            {t("vui.audio.current", describeChoice(props.settings.inputDeviceId, devices().inputs))}
          </Show>
        </p>

        <label for="voice-output-device" data-slot="label">
          {t("vui.audio.output")}
        </label>
        <select
          id="voice-output-device"
          data-slot="select"
          value={props.settings.outputDeviceId ?? ""}
          onChange={(e) => updateSettings({ outputDeviceId: e.currentTarget.value || undefined })}
        >
          <For each={devices().outputs}>{(device) => <option value={device.id}>{device.label}</option>}</For>
        </select>
        <p data-slot="hint">
          {/*
          Honest about a limit rather than quietly ignoring the setting.
          The synthesiser the assistant speaks through has no way to
          choose an output at all — it always goes to the system default
          — so a picker that pretended otherwise would be a control that
          does nothing, which is worse than one that says what it is
          waiting for.
        */}
          {t("vui.audio.output.note")}
        </p>
      </div>
    </>
  )
}
