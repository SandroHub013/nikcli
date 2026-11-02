/**
 * Button, IconButton, Field, Notice and EmptyState (DS-8, DS-9, DS-10, DS-16, DS-17).
 *
 * Thin on purpose, like `layout.tsx`: each renders the element it replaces, with the attributes `controls.css`
 * matches, and passes every other prop through — so a surface keeps its `data-slot`, its `ref`, its handlers and
 * its tests when it moves onto the primitive, and only loses the hand-written copy of the styling.
 */
import { children, createUniqueId, Show, splitProps, type JSX, type ParentProps } from "solid-js"
import { t } from "../i18n"
import {
  buttonAttrs,
  emptyStateAttrs,
  fieldAttrs,
  iconButtonAttrs,
  noticeAttrs,
  type ButtonVariant,
  type ControlSize,
  type IconButtonSize,
  type NoticeTone,
} from "./control-attrs"
import "./controls.css"

type ButtonProps = ParentProps<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize; loading?: boolean }
>

/** A text button. `loading` keeps the width, shows a spinner and refuses the press (`aria-busy`). */
export function Button(props: ButtonProps) {
  const [own, rest] = splitProps(props, ["variant", "size", "loading", "children", "disabled", "type"])
  return (
    <button
      type={own.type ?? "button"}
      {...buttonAttrs({ variant: own.variant, size: own.size, loading: own.loading })}
      disabled={own.disabled || own.loading}
      {...rest}
    >
      {own.children}
    </button>
  )
}

type IconButtonProps = ParentProps<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: IconButtonSize
    /** The accessible name. An icon has no text, so it is required, not hoped for. */
    label: string
  }
>

/** An icon you press. The glyph is the child; `label` is its name and its tooltip. */
export function IconButton(props: IconButtonProps) {
  const [own, rest] = splitProps(props, ["size", "label", "children", "type"])
  return (
    <button
      type={own.type ?? "button"}
      {...iconButtonAttrs({ size: own.size })}
      aria-label={own.label}
      title={own.label}
      {...rest}
    >
      {own.children}
    </button>
  )
}

type FieldProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  size?: "sm" | "md"
  shape?: "pill"
  /** Draws the error border and sets `aria-invalid`. */
  invalid?: boolean
  /** The message under the field, tied to it by `aria-describedby`. */
  message?: string
}

/** A single-line text field with the ring, the sunken ground and an error state. */
export function Field(props: FieldProps) {
  const [own, rest] = splitProps(props, ["size", "shape", "invalid", "message"])
  // The message's id is derived from the field's, or made up when the field has none: it has to be referable.
  const fallbackId = createUniqueId()
  const messageId = () => `${rest.id ?? fallbackId}-message`
  return (
    <>
      <input
        {...fieldAttrs({ size: own.size, shape: own.shape, invalid: own.invalid })}
        aria-describedby={own.invalid && own.message ? messageId() : undefined}
        {...rest}
      />
      <Show when={own.invalid && own.message}>
        <span data-ui="field-message" id={messageId()}>
          {own.message}
        </span>
      </Show>
    </>
  )
}

type NoticeProps = ParentProps<
  JSX.HTMLAttributes<HTMLDivElement> & {
    tone?: NoticeTone
    /** Shows the close control and calls this when it is pressed. */
    onClose?: () => void
    /** What the close control discards, for its name: «Scarta: …». */
    closeLabel?: string
    /** An optional action, drawn as a ghost button. */
    action?: { label: string; onClick: () => void }
  }
>

/** A line of news. An error is an alert, anything else a status; both close the same way. */
export function Notice(props: NoticeProps) {
  const [own, rest] = splitProps(props, ["tone", "onClose", "closeLabel", "action", "children"])
  return (
    <div {...noticeAttrs(own.tone)} {...rest}>
      <span data-ui="notice-text">{own.children}</span>
      <Show when={own.action}>
        {(action) => (
          <Button variant="ghost" size="sm" onClick={() => action().onClick()}>
            {action().label}
          </Button>
        )}
      </Show>
      <Show when={own.onClose}>
        <IconButton size="sm" label={own.closeLabel ?? t("ui.notice.close")} onClick={() => own.onClose?.()}>
          <span data-ui="icon-cross" aria-hidden="true" />
        </IconButton>
      </Show>
    </div>
  )
}

type EmptyStateProps = ParentProps<
  JSX.HTMLAttributes<HTMLDivElement> & {
    /** The mark: an `EmptyIcon` per view, or the pixel pot on the no-project screen. */
    mark?: JSX.Element
    title: string
    /** One primary action at most — an empty view has one next step. */
    action?: { label: string; onClick: () => void }
  }
>

/** What a view shows when it has nothing: a mark, a title, a line of help and at most one action. */
export function EmptyState(props: EmptyStateProps) {
  const [own, rest] = splitProps(props, ["mark", "title", "action", "children"])
  // Resolved once: a bare `own.children` in the `when` and again in the body builds the help's nodes twice.
  const help = children(() => own.children)
  return (
    <div {...emptyStateAttrs()} {...rest}>
      {own.mark}
      <p data-ui="empty-title">{own.title}</p>
      <Show when={help()}>
        <p data-ui="empty-body">{help()}</p>
      </Show>
      <Show when={own.action}>
        {(action) => (
          <Button variant="primary" size="md" onClick={() => action().onClick()}>
            {action().label}
          </Button>
        )}
      </Show>
    </div>
  )
}
