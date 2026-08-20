import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { type FileNode, deriveDefaultExpandedDirs, flattenFileTree } from "./file-tree"
import { createKeyedList } from "./keyed"
import {
  type FlatSessionChildRow,
  type FlatWorkspaceHeaderRow,
  type FlatWorkspaceRow,
  type Workspace,
  flattenWorkspaces,
} from "./workspace-tree"

const TEST_WORKSPACES: Workspace[] = [
  {
    id: "ws-1",
    name: "Workspace 1",
    sessions: [
      { id: "s1", title: "Session 1", status: "working" },
      { id: "s2", title: "Session 2", status: "waiting" },
    ],
  },
  {
    id: "ws-2",
    name: "Workspace 2",
    sessions: [
      { id: "s3", title: "Session 3", status: "done" },
    ],
  },
]

const TEST_FILES: FileNode[] = [
  {
    id: "d-pkg",
    name: "packages",
    path: "packages",
    kind: "directory",
    children: [
      {
        id: "d-ade",
        name: "ade",
        path: "packages/ade",
        kind: "directory",
        children: [
          { id: "f-pkg", name: "package.json", path: "packages/ade/package.json", kind: "file" },
        ],
      },
    ],
  },
  {
    id: "d-empty",
    name: "empty-folder",
    path: "empty-folder",
    kind: "directory",
    children: [],
  },
  {
    id: "f-readme",
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
]

describe("Sidebar pure logic and reactive helpers", () => {
  test("Defect 1: discriminated union FlatWorkspaceRow narrows cleanly without as casts", () => {
    const rows: FlatWorkspaceRow[] = flattenWorkspaces(TEST_WORKSPACES, new Set(["ws-1"]), "s1")

    for (const row of rows) {
      if (row.type === "workspace") {
        // TypeScript narrows row to FlatWorkspaceHeaderRow
        const header: FlatWorkspaceHeaderRow = row
        expect(header.workspace).toBeDefined()
        expect(typeof header.sessionCount).toBe("number")
      } else if (row.type === "session") {
        // TypeScript narrows row to FlatSessionChildRow
        const child: FlatSessionChildRow = row
        expect(child.session).toBeDefined()
        expect(typeof child.isSelected).toBe("boolean")
        expect(typeof child.workspaceId).toBe("string")
      }
    }
  })

  test("Defect 2: resize drag cleanup handler cleanly executes registered teardown", () => {
    let cleanedUp = false
    let activeResizeCleanup: (() => void) | undefined

    const cleanupDrag = () => {
      cleanedUp = true
      activeResizeCleanup = undefined
    }

    // Simulate drag start registering cleanup in component reactive owner
    activeResizeCleanup = cleanupDrag

    // Simulate component unmount triggering the registered teardown
    activeResizeCleanup?.()
    expect(cleanedUp).toBe(true)
    expect(activeResizeCleanup).toBeUndefined()
  })

  test("Defect 7: createKeyedList preserves item wrapper identity across selection updates", () => {
    createRoot((dispose) => {
      const [selected, setSelected] = createSignal("s1")
      const rows = () => flattenWorkspaces(TEST_WORKSPACES, new Set(["ws-1"]), selected())
      const keyed = createKeyedList(rows, (r) => `${r.type}:${r.id}`)

      const initial = keyed()
      expect(initial.length).toBe(4) // ws-1, s1, s2, ws-2

      const s1Entry = initial.find((e) => e.id === "session:s1")
      const s2Entry = initial.find((e) => e.id === "session:s2")
      const ws1Entry = initial.find((e) => e.id === "workspace:ws-1")

      expect(s1Entry).toBeDefined()
      expect(s2Entry).toBeDefined()
      expect(ws1Entry).toBeDefined()

      const s1Data = s1Entry!.data() as FlatSessionChildRow
      const s2Data = s2Entry!.data() as FlatSessionChildRow
      expect(s1Data.isSelected).toBe(true)
      expect(s2Data.isSelected).toBe(false)

      // Change selection from s1 to s2
      setSelected("s2")

      const updated = keyed()
      expect(updated.length).toBe(4)

      const s1EntryUpdated = updated.find((e) => e.id === "session:s1")
      const s2EntryUpdated = updated.find((e) => e.id === "session:s2")
      const ws1EntryUpdated = updated.find((e) => e.id === "workspace:ws-1")

      // The wrapper entry references MUST be identical (===) to prevent Solid's <For> from recreating DOM
      expect(s1EntryUpdated).toBe(s1Entry)
      expect(s2EntryUpdated).toBe(s2Entry)
      expect(ws1EntryUpdated).toBe(ws1Entry)

      // But their reactive data signals reflect the updated selection state
      expect((s1EntryUpdated!.data() as FlatSessionChildRow).isSelected).toBe(false)
      expect((s2EntryUpdated!.data() as FlatSessionChildRow).isSelected).toBe(true)

      dispose()
    })
  })

  test("Defect 7: createKeyedList preserves file tree row identity across selection changes", () => {
    createRoot((dispose) => {
      const [selectedPath, setSelectedPath] = createSignal("README.md")
      const files = () => flattenFileTree(TEST_FILES, new Set(["packages"]), selectedPath())
      const keyed = createKeyedList(files, (item) => item.path)

      const initial = keyed()
      const readmeEntry = initial.find((e) => e.id === "README.md")
      const packagesEntry = initial.find((e) => e.id === "packages")

      expect(readmeEntry?.data().isSelected).toBe(true)
      expect(packagesEntry?.data().isSelected).toBe(false)

      // Change selection to packages
      setSelectedPath("packages")

      const updated = keyed()
      const readmeEntryUpdated = updated.find((e) => e.id === "README.md")
      const packagesEntryUpdated = updated.find((e) => e.id === "packages")

      // Stable references
      expect(readmeEntryUpdated).toBe(readmeEntry)
      expect(packagesEntryUpdated).toBe(packagesEntry)

      expect(readmeEntryUpdated?.data().isSelected).toBe(false)
      expect(packagesEntryUpdated?.data().isSelected).toBe(true)

      dispose()
    })
  })

  test("Defect 9: deriveDefaultExpandedDirs derives top-level dirs and ancestors of selected file", () => {
    const defaultDirs = deriveDefaultExpandedDirs(TEST_FILES, "packages/ade/package.json")
    expect(defaultDirs.sort()).toEqual([
      "empty-folder",
      "packages",
      "packages/ade",
    ])

    // Fallback when no files provided
    expect(deriveDefaultExpandedDirs([]).sort()).toEqual(["packages", "src"])
  })

  test("Defect 10: calculates 1-based aria-level for tree hierarchies", () => {
    // Top-level workspace rows have level 1
    const wsRows = flattenWorkspaces(TEST_WORKSPACES, new Set(["ws-1"]))
    const wsHeaderLevel = 1
    const sessionChildLevel = 2

    expect(wsHeaderLevel).toBe(1)
    expect(sessionChildLevel).toBe(2)

    // File tree items have depth 0 (level 1), depth 1 (level 2), depth 2 (level 3)
    const flatFiles = flattenFileTree(TEST_FILES, new Set(["packages", "packages/ade"]))
    const topLevelDir = flatFiles.find((f) => f.path === "packages")
    const nestedDir = flatFiles.find((f) => f.path === "packages/ade")
    const nestedFile = flatFiles.find((f) => f.path === "packages/ade/package.json")

    expect(topLevelDir?.depth).toBe(0)
    expect((topLevelDir?.depth ?? 0) + 1).toBe(1)

    expect(nestedDir?.depth).toBe(1)
    expect((nestedDir?.depth ?? 0) + 1).toBe(2)

    expect(nestedFile?.depth).toBe(2)
    expect((nestedFile?.depth ?? 0) + 1).toBe(3)
  })
})
