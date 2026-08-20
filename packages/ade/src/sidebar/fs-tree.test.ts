import { describe, expect, it } from "bun:test"
import type { DirEntry } from "../host/shell"
import { dirEntriesToNodes, mergeChildren, markDirectoryError } from "./fs-tree"

describe("fs-tree", () => {
  it("filters and sorts correctly", () => {
    const entries: DirEntry[] = [
      { name: "node_modules", path: "/a/node_modules", is_dir: true, size: 0, modified_ms: 0 },
      { name: "file.txt", path: "/a/file.txt", is_dir: false, size: 10, modified_ms: 0 },
      { name: "a_dir", path: "/a/a_dir", is_dir: true, size: 0, modified_ms: 0 },
      { name: ".git", path: "/a/.git", is_dir: true, size: 0, modified_ms: 0 },
    ]
    const nodes = dirEntriesToNodes(entries, false)
    expect(nodes.length).toBe(2)
    expect(nodes[0].name).toBe("a_dir")
    expect(nodes[0].kind).toBe("directory")
    expect(nodes[1].name).toBe("file.txt")
  })

  it("merges children correctly", () => {
    const root = { id: "/root", name: "root", path: "/root", kind: "directory" as const }
    const entries: DirEntry[] = [
      { name: "file.txt", path: "/root/file.txt", is_dir: false, size: 10, modified_ms: 0 },
    ]
    const nextRoot = mergeChildren(root, "/root", entries, false)
    expect(nextRoot.children?.length).toBe(1)
    expect(nextRoot.children?.[0].path).toBe("/root/file.txt")
  })

  it("merges children deeply", () => {
    const root = { 
      id: "/root", name: "root", path: "/root", kind: "directory" as const, 
      children: [
        { id: "/root/dir", name: "dir", path: "/root/dir", kind: "directory" as const }
      ]
    }
    const entries: DirEntry[] = [
      { name: "file.txt", path: "/root/dir/file.txt", is_dir: false, size: 10, modified_ms: 0 },
    ]
    const nextRoot = mergeChildren(root, "/root/dir", entries, false)
    expect(nextRoot.children?.[0].children?.length).toBe(1)
    expect(nextRoot.children?.[0].children?.[0].path).toBe("/root/dir/file.txt")
  })

  it("marks error", () => {
    const root = { id: "/root", name: "root", path: "/root", kind: "directory" as const }
    const nextRoot = markDirectoryError(root, "/root")
    expect(nextRoot.children).toEqual([])
  })
})
