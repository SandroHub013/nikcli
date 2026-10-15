import wordmarkDark from "../assets/images/wordmark-dark.png"
import wordmarkLight from "../assets/images/wordmark-light.png"
import { ComponentProps } from "solid-js"
import { potRuns } from "./ragu-pot"

const POT = potRuns()

/**
 * The Ragu Code pot, one rect per run of a colour on a row of its 16 px grid, in the palette's own colours and
 * with crisp edges, so it stays pixel art at any size.
 */
const pot = () => POT.map(([x, y, width, fill]) => <rect x={x} y={y} width={width} height={1} fill={fill} />)

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 16"
      fill="none"
      shape-rendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      {pot()}
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 16"
      fill="none"
      shape-rendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      {pot()}
    </svg>
  )
}

/**
 * The pixel wordmark, RAGU CODE as the logo's combo spells it. The letters are outlined in dark tomato on
 * dark surfaces and in ink on light ones; follows the in-app color scheme (data-color-scheme) and falls back
 * to the system preference.
 */
export const Logo = (props: { class?: string }) => {
  return (
    <span
      data-component="logo-wordmark"
      role="img"
      aria-label="Ragu Code"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <img data-tone="dark" src={wordmarkDark} alt="" draggable={false} />
      <img data-tone="light" src={wordmarkLight} alt="" draggable={false} />
    </span>
  )
}
