import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { bindMenu } from "./menu"

/*
 * Review area 2, MEDIO: «Nuovo pannello» and «Notifiche» are `role="menu"`
 * and closed only from their own button: no Esc, no click outside, no arrows,
 * no focus.
 */

function setup() {
  const anchor = document.createElement("button")
  const menu = document.createElement("div")
  menu.setAttribute("role", "menu")
  for (const name of ["uno", "due", "tre"]) {
    const item = document.createElement("button")
    item.textContent = name
    menu.append(item)
  }
  const outside = document.createElement("p")
  document.body.append(anchor, menu, outside)
  let closed = 0
  const unbind = bindMenu(menu, { close: () => closed++, anchor })
  const key = (key: string) =>
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  const focused = () => document.activeElement?.textContent
  return { anchor, menu, outside, closed: () => closed, unbind, key, focused }
}

test("the first item takes the focus, and the arrows move it round the ends", async () => {
  const menu = setup()
  await Promise.resolve()
  expect(menu.focused()).toBe("uno")
  menu.key("ArrowDown")
  expect(menu.focused()).toBe("due")
  menu.key("End")
  expect(menu.focused()).toBe("tre")
  menu.key("ArrowDown")
  expect(menu.focused()).toBe("uno")
  menu.key("ArrowUp")
  expect(menu.focused()).toBe("tre")
  menu.unbind()
  document.body.innerHTML = ""
})

test("Esc closes and gives the focus back to the button", async () => {
  const menu = setup()
  await Promise.resolve()
  menu.key("Escape")
  expect(menu.closed()).toBe(1)
  expect(document.activeElement).toBe(menu.anchor)
  menu.unbind()
  document.body.innerHTML = ""
})

test("a press outside closes; on the menu or its button it does not", () => {
  const menu = setup()
  menu.menu.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  menu.anchor.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  expect(menu.closed()).toBe(0)
  menu.outside.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  expect(menu.closed()).toBe(1)
  menu.unbind()
  menu.outside.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  expect(menu.closed()).toBe(1)
  document.body.innerHTML = ""
})

test("lint: both menus of the bar are bound", () => {
  const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
  expect(source).toContain("bindMenu(menu, { close: () => setNewPaneOpen(false), anchor: newPaneButton })")
  expect(source).toContain("bindMenu(menu, { close: () => setNoticesOpen(false), anchor: noticesButton })")
})
