import { useTheme } from "../context/theme"
import { DialogHeader, useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Locale } from "@nikcli-ai/util/locale"

type ConfirmKey = "cancel" | "extra" | "confirm"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  /** Which button should be focused by default. Defaults to "cancel" for safety. */
  defaultFocus?: "confirm" | "cancel"
  /** Button text; defaults to "Cancel" and "Confirm". */
  labels?: { confirm?: string; cancel?: string }
  /** A third choice between cancel and confirm, e.g. "Auto-update". */
  extra?: { label: string; onSelect: () => void }
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: (props.defaultFocus ?? "cancel") as ConfirmKey,
  })
  const keys = (): ConfirmKey[] => (props.extra ? ["cancel", "extra", "confirm"] : ["cancel", "confirm"])
  const label = (key: ConfirmKey) => {
    if (key === "extra") return props.extra?.label ?? ""
    return props.labels?.[key] ?? Locale.titlecase(key)
  }
  const select = (key: ConfirmKey) => {
    if (key === "confirm") props.onConfirm?.()
    if (key === "cancel") props.onCancel?.()
    if (key === "extra") props.extra?.onSelect()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      select(store.active)
      return
    }

    // Y/N shortcuts for quick confirm/cancel
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      evt.stopPropagation()
      props.onConfirm?.()
      dialog.clear()
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      evt.stopPropagation()
      props.onCancel?.()
      dialog.clear()
      return
    }

    if (evt.name === "left" || evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      const all = keys()
      const step = evt.name === "right" ? 1 : all.length - 1
      setStore("active", all[(all.indexOf(store.active) + step) % all.length])
    }
  })
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <DialogHeader title={props.title} />
      <box paddingBottom={1}>
        <text fg={theme.foreground.muted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={2}>
        <For each={keys()}>
          {(key) => (
            <box
              paddingLeft={4}
              paddingRight={4}
              paddingTop={1}
              paddingBottom={1}
              border={true}
              borderColor={key === store.active ? theme.border.focus : theme.border.default}
              backgroundColor={key === store.active ? theme.badge.bg : undefined}
              onMouseUp={() => select(key)}
            >
              <text fg={key === store.active ? theme.badge.fg : theme.foreground.muted}>{label(key)}</text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <text fg={theme.foreground.muted}>
          Y/N or <span style={{ fg: theme.foreground.default }}>←→</span> to switch,{" "}
          <span style={{ fg: theme.foreground.default }}>enter</span> to confirm
        </text>
      </box>
    </box>
  )
}

DialogConfirm.show = (dialog: DialogContext, title: string, message: string, defaultFocus?: "confirm" | "cancel") => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          defaultFocus={defaultFocus}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}

/**
 * Three-way variant: resolves to the button chosen, and to "cancel" when the
 * dialog is dismissed.
 */
DialogConfirm.choose = (
  dialog: DialogContext,
  input: {
    title: string
    message: string
    labels: { confirm: string; cancel: string; extra: string }
    defaultFocus?: "confirm" | "cancel"
  },
) => {
  return new Promise<ConfirmKey>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={input.title}
          message={input.message}
          defaultFocus={input.defaultFocus}
          labels={input.labels}
          extra={{ label: input.labels.extra, onSelect: () => resolve("extra") }}
          onConfirm={() => resolve("confirm")}
          onCancel={() => resolve("cancel")}
        />
      ),
      () => resolve("cancel"),
    )
  })
}
