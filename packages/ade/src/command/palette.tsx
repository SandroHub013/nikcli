import { createSignal, createMemo, createEffect, Show, For } from "solid-js"
import { type Command, type CommandHit, filterCommands, moveSelection } from "./registry"
import { parseChord, formatChord } from "../keyboard/keymap"
import "./palette.css"

export interface CommandPaletteProps {
  open: boolean
  commands: Command[]
  /** Chiamata con l'id del comando scelto. */
  onRun: (id: string) => void
  onClose: () => void
  /** Piattaforma per la resa delle scorciatoie. */
  platform: "mac" | "other"
  /** Testo mostrato quando nessun comando corrisponde. */
  emptyLabel?: string
}

export interface GroupedHits {
  name: string
  hits: { hit: CommandHit; index: number }[]
}

export function groupHits(hits: CommandHit[]): GroupedHits[] {
  const result: GroupedHits[] = []
  const groupMap = new Map<string, number>()

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const gName = hit.command.group
    let gIdx = groupMap.get(gName)
    if (gIdx === undefined) {
      gIdx = result.length
      groupMap.set(gName, gIdx)
      result.push({ name: gName, hits: [] })
    }
    result[gIdx].hits.push({ hit, index: i })
  }
  return result
}

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let inputRef!: HTMLInputElement
  let listboxRef!: HTMLDivElement
  let previousFocus: HTMLElement | null = null

  const hits = createMemo(() => filterCommands(props.commands, query()))
  const groups = createMemo(() => groupHits(hits()))

  createEffect(() => {
    const list = hits()
    setSelectedIndex(moveSelection(list, -1, 1))
  })

  createEffect(() => {
    if (props.open) {
      previousFocus = document.activeElement as HTMLElement
      setQuery("")
      const initialHits = filterCommands(props.commands, "")
      setSelectedIndex(moveSelection(initialHits, -1, 1))
      setTimeout(() => inputRef?.focus(), 0)
    } else {
      if (previousFocus) {
        previousFocus.focus()
        previousFocus = null
      }
    }
  })

  createEffect(() => {
    const idx = selectedIndex()
    if (idx >= 0 && listboxRef) {
      const el = listboxRef.querySelector(`[data-index="${idx}"]`) as HTMLElement
      if (el) {
        el.scrollIntoView({ block: "nearest" })
      }
    }
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return
    
    const list = hits()
    
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      setSelectedIndex(prev => moveSelection(list, prev, 1))
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      setSelectedIndex(prev => moveSelection(list, prev, -1))
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(moveSelection(list, -1, 1))
    } else if (e.key === "End") {
      e.preventDefault()
      setSelectedIndex(moveSelection(list, list.length, -1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const idx = selectedIndex()
      if (idx >= 0 && idx < list.length) {
        const hit = list[idx]
        if (hit.command.enabled !== false) {
          props.onRun(hit.command.id)
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
    }
  }

  const highlightText = (text: string, ranges: [number, number][]) => {
    if (!ranges.length) return text
    const parts = []
    let last = 0
    for (const [s, e] of ranges) {
      if (s > last) parts.push(<span class="ade-cp-text">{text.slice(last, s)}</span>)
      parts.push(<span class="ade-cp-highlight">{text.slice(s, e)}</span>)
      last = e
    }
    if (last < text.length) parts.push(<span class="ade-cp-text">{text.slice(last)}</span>)
    return parts
  }

  return (
    <Show when={props.open}>
      <div 
        class="ade-cp-backdrop" 
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div 
          class="ade-cp-dialog" 
          role="dialog" 
          aria-modal="true"
          aria-label="Command Palette"
        >
          <div class="ade-cp-input-wrap">
            <input
              ref={inputRef}
              class="ade-cp-input"
              role="combobox"
              aria-expanded="true"
              aria-controls="ade-cp-listbox"
              aria-activedescendant={selectedIndex() >= 0 ? `ade-cp-option-${selectedIndex()}` : undefined}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Cerca un comando…"
            />
          </div>
          <div class="ade-cp-listbox" role="listbox" id="ade-cp-listbox" ref={listboxRef}>
            <Show 
              when={hits().length > 0} 
              fallback={<div class="ade-cp-empty">{props.emptyLabel ?? "No commands found."}</div>}
            >
              <For each={groups()}>
                {(group) => (
                  <div class="ade-cp-group">
                    <div class="ade-cp-group-title">
                      {group.hits.length > 0 ? highlightText(group.name, group.hits[0].hit.groupRanges) : group.name}
                    </div>
                    <For each={group.hits}>
                      {({ hit, index }) => {
                        const isSelected = () => selectedIndex() === index
                        const disabled = hit.command.enabled === false
                        return (
                          <div
                            id={`ade-cp-option-${index}`}
                            data-index={index}
                            class="ade-cp-option"
                            role="option"
                            aria-selected={isSelected()}
                            aria-disabled={disabled}
                            onPointerEnter={() => !disabled && setSelectedIndex(index)}
                            onClick={() => {
                              if (!disabled) props.onRun(hit.command.id)
                            }}
                          >
                            <div class="ade-cp-option-title">
                              {highlightText(hit.command.title, hit.titleRanges)}
                            </div>
                            <Show when={hit.command.shortcut}>
                              <div class="ade-cp-option-shortcut">
                                {formatChord(parseChord(hit.command.shortcut!, props.platform), props.platform)}
                              </div>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
