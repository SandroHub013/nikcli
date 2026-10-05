import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { Linking, Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native"
import Markdown from "react-native-markdown-display"
import {
  isModElement,
  MOD_INPUT_SETTLE_MS,
  modColor,
  safeHref,
  type ModBoxProps,
  type ModElement,
  type ModEvents,
  type ModNode,
} from "@/lib/mod-tree"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { mono, type as typeStyle } from "@/lib/typography"

/**
 * Draws a tree a mod answered with, as native views.
 *
 * The terminal draws the same tree with boxes and cells; here a `Box` is a `View`, a `Button` is a
 * pressable with a real touch target, and an `Input` is a text field. A mod that wants a different
 * layout on a phone branches on the `surface` it was asked for and sends a different tree — this
 * renderer only draws what it is given. Terminal-only props (`width` in cells, `hotkey`, `inverse`)
 * are read for what they mean on a phone, or ignored.
 */

const BORDER_WIDTH = { single: 1, double: 2, round: 1, bold: 2 } as const
/** Terminal cells are not points: one `gap` or `padding` unit is a few points on a phone. */
const UNIT = 4

function boxStyle(props: ModBoxProps, palette: ReturnType<typeof useAppTheme>["palette"]): ViewStyle {
  const border = props.borderStyle
  const background = modColor(props.backgroundColor, palette)
  return {
    flexDirection: props.direction ?? "column",
    gap: props.gap === undefined ? undefined : props.gap * UNIT,
    padding: props.padding === undefined ? undefined : props.padding * UNIT * 2,
    margin: props.margin === undefined ? undefined : props.margin * UNIT,
    // A number is a count of terminal cells, which means nothing here; only a percentage is a size.
    width:
      typeof props.width === "string" && /^\d+(\.\d+)?%$/.test(props.width) ? (props.width as `${number}%`) : undefined,
    height: props.height === undefined ? undefined : props.height * UNIT * 4,
    justifyContent: props.justifyContent,
    alignItems: props.alignItems,
    backgroundColor: background,
    ...(border
      ? {
          borderWidth: BORDER_WIDTH[border],
          borderColor: hexToRgba(palette.ink, 0.16),
          borderRadius: border === "round" ? 12 : 4,
          borderCurve: "continuous" as const,
        }
      : null),
  }
}

function textStyle(
  props: {
    color?: string
    bold?: boolean
    italic?: boolean
    underline?: boolean
    dimColor?: boolean
    backgroundColor?: string
  },
  palette: ReturnType<typeof useAppTheme>["palette"],
): TextStyle {
  return {
    color: modColor(props.color, palette) ?? (props.dimColor ? palette.muted : palette.ink),
    backgroundColor: modColor(props.backgroundColor, palette),
    fontWeight: props.bold ? "700" : undefined,
    fontStyle: props.italic ? "italic" : undefined,
    textDecorationLine: props.underline ? "underline" : undefined,
  }
}

/** The inline content of a `Text`: strings, numbers, and nested `Text` as styled spans. */
function Inline({ children }: { children: ModNode[] }): ReactNode {
  const { palette } = useAppTheme()
  return children.map((child, index) => {
    if (typeof child === "string" || typeof child === "number") return String(child)
    if (isModElement(child) && child.type === "Text") {
      return (
        <Text key={child.key ?? index} style={textStyle(child.props, palette)}>
          <Inline children={child.children} />
        </Text>
      )
    }
    return null
  })
}

function Field({ element, events }: { element: Extract<ModElement, { type: "Input" }>; events: ModEvents }) {
  const { palette, colorScheme } = useAppTheme()
  const [value, setValue] = useState(element.props.value ?? "")
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { key, props } = element

  // A new tree carries the mod's own value for this field; typing in between is the user's.
  useEffect(() => {
    setValue(props.value ?? "")
  }, [props.value])
  useEffect(() => () => settle.current && clearTimeout(settle.current), [])

  return (
    <View style={{ gap: 6 }}>
      {props.label ? (
        <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>{props.label}</Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          style={{
            flex: 1,
            minHeight: 44,
            paddingHorizontal: 14,
            borderRadius: 999,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: hexToRgba(palette.ink, 0.12),
            backgroundColor: palette.surfaceRaised,
            color: palette.ink,
            ...typeStyle(15),
          }}
          value={value}
          placeholder={props.placeholder}
          placeholderTextColor={palette.muted}
          selectionColor={palette.ink}
          keyboardAppearance={colorScheme === "light" ? "light" : "dark"}
          autoFocus={props.autoFocus}
          autoCapitalize="none"
          accessibilityLabel={props.label ?? props.placeholder}
          returnKeyType={props.submitLabel ? "send" : "done"}
          onChangeText={(next) => {
            setValue(next)
            if (settle.current) clearTimeout(settle.current)
            settle.current = setTimeout(() => events.input(key, next, false), MOD_INPUT_SETTLE_MS)
          }}
          onSubmitEditing={() => {
            if (settle.current) clearTimeout(settle.current)
            events.input(key, value, true)
          }}
        />
        {props.submitLabel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.submitLabel}
            hitSlop={8}
            onPress={() => {
              if (settle.current) clearTimeout(settle.current)
              events.input(key, value, true)
            }}
          >
            <Text style={{ color: palette.accent, ...typeStyle(14, { weight: "600" }) }}>{props.submitLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

/** A mod's own `key` when the element has one, so a reordered list keeps its fields' state. */
function childKey(child: ModNode, index: number) {
  if (isModElement(child) && "key" in child && child.key) return child.key
  return index
}

function Node({ node, events }: { node: ModNode; events: ModEvents }): ReactNode {
  const { palette } = useAppTheme()

  if (typeof node === "string" || typeof node === "number") {
    return <Text style={{ color: palette.ink, ...typeStyle(15) }}>{String(node)}</Text>
  }
  if (!isModElement(node)) return null

  switch (node.type) {
    case "Box":
      return (
        <View style={boxStyle(node.props, palette)}>
          {node.children.map((child, index) => (
            <Node key={childKey(child, index)} node={child} events={events} />
          ))}
        </View>
      )
    case "Text":
      return (
        <Text
          style={{ ...typeStyle(15), ...textStyle(node.props, palette) }}
          numberOfLines={node.props.wrap === "none" ? 1 : undefined}
        >
          <Inline children={node.children} />
        </Text>
      )
    case "Button": {
      const { label, plain, dimColor } = node.props
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => events.press(node.key)}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: plain ? 0 : 16,
            borderRadius: 999,
            borderCurve: "continuous",
            backgroundColor: plain ? "transparent" : palette.surfaceRaised,
            borderWidth: plain ? 0 : 1,
            borderColor: hexToRgba(palette.ink, 0.1),
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: dimColor ? palette.muted : palette.accent, ...typeStyle(14, { weight: "600" }) }}>
            {label}
          </Text>
        </Pressable>
      )
    }
    case "Link": {
      const href = safeHref(node.props.href)
      const label = node.props.label ?? node.props.href
      return (
        <Text
          accessibilityRole={href ? "link" : undefined}
          onPress={href ? () => void Linking.openURL(href).catch(() => undefined) : undefined}
          style={{
            color: href ? palette.accent : palette.muted,
            textDecorationLine: href ? "underline" : "none",
            ...typeStyle(15),
          }}
        >
          {label}
        </Text>
      )
    }
    case "Code":
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ borderRadius: 10, borderCurve: "continuous", backgroundColor: palette.codeBlockBackground }}
          contentContainerStyle={{ padding: 12 }}
        >
          <Text selectable style={{ color: palette.codeText, ...mono(13) }}>
            {node.props.text}
          </Text>
        </ScrollView>
      )
    case "Markdown":
      return (
        <Markdown
          style={{
            body: { color: node.props.dimColor ? palette.muted : palette.ink, ...typeStyle(15) },
            link: { color: palette.accent },
            code_inline: { backgroundColor: palette.codeBackground, color: palette.codeText },
            fence: { backgroundColor: palette.codeBlockBackground, color: palette.codeText },
            code_block: { backgroundColor: palette.codeBlockBackground, color: palette.codeText },
          }}
          onLinkPress={(url) => {
            const href = safeHref(url)
            if (href) void Linking.openURL(href).catch(() => undefined)
            // Returning false stops the library opening the URL itself, which would skip the scheme check.
            return false
          }}
        >
          {node.props.text}
        </Markdown>
      )
    case "Input":
      return <Field element={node} events={events} />
    case "Select":
      return (
        <View style={{ gap: 6 }} accessibilityRole="radiogroup">
          {node.props.label ? (
            <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>{node.props.label}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {node.props.options.map((option) => {
              const selected = node.props.value === option.value
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label ?? option.value}
                  onPress={() => events.select(node.key, option.value)}
                  style={{
                    minHeight: 40,
                    justifyContent: "center",
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: selected ? palette.accent : hexToRgba(palette.ink, 0.12),
                    backgroundColor: selected ? hexToRgba(palette.accent, 0.14) : palette.surfaceRaised,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? palette.accent : palette.ink,
                      ...typeStyle(14, { weight: selected ? "600" : "500" }),
                    }}
                  >
                    {option.label ?? option.value}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      )
  }
}

export const ModTree = memo(function ModTree({ node, events }: { node: ModNode; events: ModEvents }) {
  return (
    <View>
      <Node node={node} events={events} />
    </View>
  )
})
