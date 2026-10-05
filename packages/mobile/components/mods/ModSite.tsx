import type { ReactNode } from "react"
import { Text, View } from "react-native"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"
import { useModSite } from "./ModHost"
import { ModTree } from "./ModTree"

/**
 * One place a mod draws: the band above the composer, or a pane. It shows the mods' tree when one
 * answered, and `empty` (nothing, by default) when none did — so a mod that draws only for the
 * terminal leaves no empty card on the phone. With a `title` the drawing sits in a titled card.
 */
export function ModSite(props: {
  component: "AbovePrompt" | "Pane"
  requestId: string
  sessionID?: string
  extra?: Record<string, unknown>
  title?: string
  empty?: ReactNode
}) {
  const { palette } = useAppTheme()
  const { answer, events } = useModSite({
    component: props.component,
    requestId: props.requestId,
    sessionID: props.sessionID,
    props: props.extra,
    always: true,
  })
  if (!answer || answer.tree === null || answer.tree === undefined) return <>{props.empty ?? null}</>
  const tree = <ModTree node={answer.tree} events={events} />
  if (!props.title) return tree
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: hexToRgba(palette.ink, 0.08),
        backgroundColor: palette.surfaceRaised,
      }}
    >
      <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "600" }) }}>{props.title}</Text>
      {tree}
    </View>
  )
}
