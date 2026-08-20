/**
 * Element context serializer for the browser pane.
 *
 * Turns inspected DOM elements into compact, agent-readable text blocks that
 * attach to the prompt.
 *
 * Sizing and style choices:
 * - A full `getComputedStyle` dump is ~300 properties per element. Dumping raw
 *   styles or full outerHTML for multiple elements wastes thousands of context
 *   tokens on default browser values.
 * - Squeezing each element into 4-5 focused lines (selector, geometry, layout,
 *   typography/colors, text snippet) gives the agent all actionable styling and
 *   structural context without bloating the prompt window.
 * - Missing or partial properties must never throw; all field accesses use safe
 *   fallbacks.
 */

import type { InspectedElement } from "./protocol"

export interface FormatSelectionOptions {
  url?: string
  instruction?: string
}

/**
 * Sanitizes a text snippet for prompt context by stripping line breaks and
 * capping length so large text nodes do not dominate the prompt.
 */
function cleanTextSnippet(text: unknown, maxLen = 100): string {
  if (typeof text !== "string") return ""
  const singleLine = text.replace(/[\r\n\t]+/g, " ").trim()
  if (singleLine.length <= maxLen) return singleLine
  return `${singleLine.slice(0, maxLen)}...`
}

/**
 * Formats a single inspected element into structured, agent-readable lines.
 */
export function describeElement(
  element: Partial<InspectedElement> | null | undefined,
  index?: number,
): string {
  if (!element || typeof element !== "object") {
    return index !== undefined ? `${index + 1}. <unknown>` : "<unknown>"
  }

  const tagName = (element.tagName || "element").toLowerCase()
  const id = element.id ? `#${element.id}` : ""
  
  let classes = ""
  if (typeof element.className === "string" && element.className.trim()) {
    const classList = element.className
      .trim()
      .split(/\s+/)
      .filter((c) => c && !c.startsWith("__nikcli"))
      .slice(0, 3)
    if (classList.length > 0) {
      classes = `.${classList.join(".")}`
    }
  }

  const lang = element.detectedLanguage || "html"
  const prefix = index !== undefined ? `${index + 1}. ` : ""
  const headerLine = `${prefix}<${tagName}${id}${classes}> (${lang})`

  const selector = element.selector || `${tagName}${id}${classes}`
  const selectorLine = `   selector: ${selector}`

  const rect = element.rect ?? { width: 0, height: 0, top: 0, left: 0 }
  const styles = element.styles ?? ({} as Partial<NonNullable<InspectedElement["styles"]>>)

  const width = Math.round(rect.width ?? 0)
  const height = Math.round(rect.height ?? 0)
  const display = styles.display || "block"
  const padding = styles.padding || "0"
  const margin = styles.margin || "0"
  const boxLine = `   box: ${width}×${height} · display: ${display} · padding: ${padding} · margin: ${margin}`

  const color = styles.color || "-"
  const fontSize = styles.fontSize || "-"
  const fontWeight = styles.fontWeight || "-"
  const bg = styles.backgroundColor || "-"
  const radius = styles.borderRadius || "-"
  const styleLine = `   text: ${color} ${fontSize}/${fontWeight} · background: ${bg} · radius: ${radius}`

  const lines = [headerLine, selectorLine, boxLine, styleLine]

  const snippet = cleanTextSnippet(element.innerText)
  if (snippet) {
    lines.push(`   content: "${snippet}"`)
  }

  return lines.join("\n")
}

/**
 * Formats a list of inspected elements into a unified prompt block with a summary
 * header and optional follow-up instruction.
 */
export function formatSelectionContext(
  elements: readonly Partial<InspectedElement>[],
  options?: FormatSelectionOptions,
): string {
  if (!elements || elements.length === 0) return ""

  const count = elements.length
  const countLabel = `${count} element${count === 1 ? "" : "s"}`
  const urlLabel = options?.url ? ` on ${options.url}` : ""
  const header = `[Design Mode · ${countLabel}${urlLabel}]`

  const body = elements.map((el, i) => describeElement(el, i)).join("\n")

  if (options?.instruction && options.instruction.trim()) {
    return `${header}\n${body}\n\n${options.instruction.trim()}\n`
  }

  return `${header}\n${body}\n`
}
