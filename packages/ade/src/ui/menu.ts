/**
 * What a `role="menu"` owes the keyboard and the pointer, for the bar's small
 * menus that are a `<div>` under a button rather than a Kobalte menu.
 *
 * «Nuovo pannello» and «Notifiche» closed only from their own button or an
 * item: Esc did nothing, a click elsewhere left them open, the arrows did not
 * move and the focus stayed on the button (review area 2, MEDIO). Bound when
 * the menu is shown; the returned function unbinds it.
 *
 * - the first item takes the focus;
 * - ArrowDown / ArrowUp / Home / End move it among the items, round the ends;
 * - Esc closes and gives the focus back to the button that opened it;
 * - a press outside the menu and its button closes it.
 */
export function bindMenu(menu: HTMLElement, options: { close: () => void; anchor?: HTMLElement | null }): () => void {
  // The page's document, not `menu.ownerDocument`: Solid runs the ref on a
  // clone of its template before inserting it, and the clone still belongs to
  // the template's inert document, where no press or focus ever happens
  // (Verifiche, medi-restyle).
  const doc = document
  const items = () =>
    [
      ...menu.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [role="menuitem"]:not([aria-disabled="true"])',
      ),
    ].filter((item, index, all) => all.indexOf(item) === index)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      options.close()
      options.anchor?.focus()
      return
    }
    const list = items()
    if (list.length === 0) return
    const at = list.indexOf(doc.activeElement as HTMLElement)
    const next =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at < 0
            ? list.length - 1
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? list.length - 1
              : undefined
    if (next === undefined) return
    event.preventDefault()
    list[(next + list.length) % list.length]?.focus()
  }
  const onPress = (event: Event) => {
    const target = event.target as Node | null
    if (target && (menu.contains(target) || options.anchor?.contains(target))) return
    options.close()
  }
  menu.addEventListener("keydown", onKey)
  doc.addEventListener("pointerdown", onPress, true)
  queueMicrotask(() => {
    if (menu.isConnected) items()[0]?.focus()
  })
  return () => {
    menu.removeEventListener("keydown", onKey)
    doc.removeEventListener("pointerdown", onPress, true)
  }
}
