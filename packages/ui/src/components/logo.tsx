import wordmarkDark from "../assets/images/wordmark-dark.png"
import wordmarkLight from "../assets/images/wordmark-light.png"
import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        data-slot="logo-logo-mark-shadow"
        d="M4 8H8V12H4ZM8 8H12V12H8ZM4 12H8V16H4ZM8 12H12V16H8ZM4 16H8V20H4ZM8 16H12V20H8Z"
        fill="var(--icon-weak-base)"
      />
      <path
        data-slot="logo-logo-mark-n"
        d="M0 0H4V4H0ZM4 0H8V4H4ZM8 0H12V4H8ZM0 4H4V8H0ZM12 4H16V8H12ZM0 8H4V12H0ZM12 8H16V12H12ZM0 12H4V16H0ZM12 12H16V16H12ZM0 16H4V20H0ZM12 16H16V20H12Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M20 40H40V60H20ZM40 40H60V60H40ZM20 60H40V80H20ZM40 60H60V80H40ZM20 80H40V100H20ZM40 80H60V100H40Z"
        fill="var(--icon-base)"
      />
      <path
        d="M0 0H20V20H0ZM20 0H40V20H20ZM40 0H60V20H40ZM0 20H20V40H0ZM60 20H80V40H60ZM0 40H20V60H0ZM60 40H80V60H60ZM0 60H20V80H0ZM60 60H80V80H60ZM0 80H20V100H0ZM60 80H80V100H60Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

/**
 * The pixel wordmark. Pale letters on dark surfaces, ink letters on light ones; follows the
 * in-app color scheme (data-color-scheme) and falls back to the system preference.
 */
export const Logo = (props: { class?: string }) => {
  return (
    <span
      data-component="logo-wordmark"
      role="img"
      aria-label="Nikcli"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <img data-tone="dark" src={wordmarkDark} alt="" draggable={false} />
      <img data-tone="light" src={wordmarkLight} alt="" draggable={false} />
    </span>
  )
}
