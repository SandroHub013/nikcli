import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * Live test 3, FAIL 8: on a fresh profile the screen said «Nessun progetto aperto» while the sidebar showed a folder,
 * its file tree and «+ Avvia nuovo agente». The sidebar discovers a project of its own from the folder ADE was started
 * in when it is given none: from the Start menu that is the install folder, the very case UX-5 came from. When the
 * workbench says there is no project, the sidebar offers none. A fake host, never a real one.
 */
if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const asked: string[] = []
const realShell = { ...(await import("../host/shell")) }
const fakeHost = {
  currentDir: async () => {
    asked.push("currentDir")
    return "C:/Program Files/ADE"
  },
  run: async () => ({ code: 1, stdout: "", stderr: "" }),
  homeDir: async () => "C:/Users/me",
  readDir: async (directory: string) => {
    asked.push(`readDir ${directory}`)
    return [{ name: "ade.exe", path: `${directory}/ade.exe`, is_dir: false, size: 1, modified_ms: 0 }]
  },
}
mock.module("../host/shell", () => ({ ...realShell, getHost: async () => fakeHost }))
afterAll(() => {
  mock.module("../host/shell", () => realShell)
})

const { createRoot } = await import("solid-js")
const { createComponent, render } = await import("solid-js/web")
const { Sidebar } = await import("./sidebar")
type SidebarProps = Parameters<typeof Sidebar>[0]

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

function mount(props: Partial<SidebarProps>) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    render(() => createComponent(Sidebar, { workspaces: [], onNewSession: () => {}, ...props }), host)
    return dispose
  })
  return { host, dispose }
}

afterEach(() => {
  document.body.innerHTML = ""
  localStorage.clear()
  asked.length = 0
})

describe("the sidebar with no project open", () => {
  test("with no project and nothing said, it still looks at the folder ADE started in (the browser harness, the standalone sidebar)", async () => {
    const { host, dispose } = mount({})
    await settle()
    expect(host.querySelector('[data-slot="project-name-text"]')?.textContent).toBe("ADE")
    expect(host.querySelector('[data-slot="search-box"]')).not.toBeNull()
    dispose()
  })

  test("told there is no project, it shows no folder, no file tree and does not read the disk for one", async () => {
    const { host, dispose } = mount({ noProject: true })
    await settle()
    expect(host.querySelector('[data-slot="project-name-text"]')).toBeNull()
    expect(host.querySelector('[data-slot="project-path"]')).toBeNull()
    // The search box and its Files and Folders chips search a project: with none they answer «no file» to anything.
    expect(host.querySelector('[data-slot="search-box"]')).toBeNull()
    expect(host.querySelector('[data-slot="search-kind"]')).toBeNull()
    expect(host.textContent).not.toContain("ade.exe")
    expect(asked.filter((line) => line.startsWith("readDir"))).toEqual([])
    dispose()
  })

  test("and a project given later brings its folder back", async () => {
    const { createSignal } = await import("solid-js")
    const [noProject, setNoProject] = createSignal(true)
    const [project, setProject] = createSignal<SidebarProps["project"]>()
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = createRoot((dispose) => {
      render(
        () =>
          createComponent(Sidebar, {
            workspaces: [],
            get noProject() {
              return noProject()
            },
            get project() {
              return project()
            },
          }),
        host,
      )
      return dispose
    })
    await settle()
    expect(host.querySelector('[data-slot="project-name-text"]')).toBeNull()
    setProject({ root: "C:/work/demo", name: "demo", git: false })
    setNoProject(false)
    await settle()
    expect(host.querySelector('[data-slot="project-name-text"]')?.textContent).toBe("demo")
    dispose()
  })
})
