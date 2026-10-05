import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { ChipMenu } = await import("./chip-menu")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

/*
 * A JSX prop is a getter: every read of `props.status` builds its elements
 * again. The menu read `status` and `footer` twice each (once for the `Show`,
 * once for the content), which built the band twice and dropped one copy; the
 * same pattern in the bell menu bound a listener to the document from the
 * dropped copy and closed the menu on the press that opened it. These tests
 * count the builds, which is the thing a copy that nobody sees can be told by.
 */
function mount(extra: { status?: () => HTMLElement | undefined; footer?: () => HTMLElement | undefined }) {
  const host = document.createElement("div")
  document.body.append(host)
  const built = { status: 0, footer: 0 }
  dispose = render(
    () =>
      createComponent(ChipMenu, {
        label: "Modello",
        text: "Sonnet",
        value: "a",
        kind: "model",
        items: [{ kind: "option", value: "a", label: "A" }] as never,
        onChoose: () => {},
        get status() {
          built.status++
          return extra.status?.()
        },
        get footer() {
          built.footer++
          return extra.footer?.()
        },
      }),
    host,
  )
  const open = () => document.body.querySelector<HTMLButtonElement>('[data-slot="chip"]')!.click()
  return { built, open }
}

const probe = (name: string) => () => {
  const element = document.createElement("span")
  element.dataset.slot = "probe"
  element.dataset.name = name
  return element
}

describe("the chip menu reads its status and footer once", () => {
  test("opened, each band is built once and shows one copy", () => {
    const { built, open } = mount({ status: probe("status"), footer: probe("footer") })
    // Closed, nothing of the popover exists, so nothing of the bands has been read.
    expect(built).toEqual({ status: 0, footer: 0 })
    open()

    expect(document.body.querySelectorAll('[data-slot="chip-status"] [data-slot="probe"]').length).toBe(1)
    expect(document.body.querySelectorAll('[data-slot="chip-footer"] [data-slot="probe"]').length).toBe(1)
    expect(built).toEqual({ status: 1, footer: 1 })
  })

  test("the copy that is shown is the one that was built", () => {
    const made: HTMLElement[] = []
    const { open } = mount({
      status: () => {
        const element = probe("status")()
        made.push(element)
        return element
      },
    })
    open()
    expect(made.length).toBe(1)
    expect(document.body.querySelector('[data-slot="chip-status"] [data-slot="probe"]')).toBe(made[0]!)
  })

  test("with nothing to say, the band is not drawn at all", () => {
    const { built, open } = mount({})
    open()
    expect(document.body.querySelector('[data-slot="chip-status"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="chip-footer"]')).toBeNull()
    // Read once each, to find that there is nothing.
    expect(built).toEqual({ status: 1, footer: 1 })
  })

  test("closing and opening again does not pile copies up", () => {
    const { built, open } = mount({ status: probe("status") })
    open()
    open() // closes
    open() // opens again
    expect(document.body.querySelectorAll('[data-slot="probe"]').length).toBe(1)
    expect(built.status).toBe(2)
  })
})
