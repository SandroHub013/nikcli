import type { JSX } from "solid-js"
import type { CategoryId } from "./categories"

export interface IconProps {
  class?: string
  size?: number
}

export function GeneralIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <line x1="2" y1="4" x2="14" y2="4" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2" y1="12" x2="14" y2="12" />
      <circle cx="5" cy="4" r="1.5" fill="none" />
      <circle cx="11" cy="8" r="1.5" fill="none" />
      <circle cx="7" cy="12" r="1.5" fill="none" />
    </svg>
  )
}

export function AgentsIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <circle cx="8" cy="5" r="2.75" />
      <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  )
}

export function ExtensionsIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <path d="M6 2.5h4v1.5a1.25 1.25 0 0 0 2.5 0V2.5h1a1 1 0 0 1 1 1v1h-1.5a1.25 1.25 0 0 0 0 2.5H14.5v4a1 1 0 0 1-1 1h-4v-1.5a1.25 1.25 0 0 0-2.5 0V13.5h-4a1 1 0 0 1-1-1v-4h1.5a1.25 1.25 0 0 0 0-2.5H2.5v-2a1 1 0 0 1 1-1h2.5z" />
    </svg>
  )
}

export function VoiceIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <rect x="5.5" y="2" width="5" height="7" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0" />
      <line x1="8" y1="12.5" x2="8" y2="14.5" />
      <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" />
    </svg>
  )
}

export function RecordIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SystemIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 16
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06" />
    </svg>
  )
}

export function CloseIcon(props: IconProps): JSX.Element {
  const s = props.size ?? 14
  return (
    <svg
      viewBox="0 0 16 16"
      width={s}
      height={s}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class}
    >
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
    </svg>
  )
}

export function CategoryIcon(props: { category: CategoryId; class?: string; size?: number }): JSX.Element {
  switch (props.category) {
    case "general":
      return <GeneralIcon {...props} />
    case "agents":
      return <AgentsIcon {...props} />
    case "extensions":
      return <ExtensionsIcon {...props} />
    case "voice":
      return <VoiceIcon {...props} />
    case "record":
      return <RecordIcon {...props} />
    case "system":
      return <SystemIcon {...props} />
  }
}
