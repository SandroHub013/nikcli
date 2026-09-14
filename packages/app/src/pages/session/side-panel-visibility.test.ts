import { describe, expect, test } from "bun:test"
import { shouldRenderBareReview } from "./side-panel-visibility"

/**
 * Two failures meet here.
 *
 * Dropping the strip while a file, the context pane or the browser is selected
 * leaves that tab active with nothing able to render it. But never dropping it
 * is just as bad: the strip's review trigger is gated on the file tree being
 * closed, so with the tree open this shortcut is the only route to the diff.
 *
 * The ids are the real ones — file tabs carry the `file://` scheme — because a
 * bare path is classified `unknown`, and testing with bare paths would let the
 * file case pass through the wrong branch.
 */

const STRIP_ONLY_TABS = ["file://src/index.ts", "file://packages/app/README.md", "context", "browser", "browser://localhost:3000"]

const openOnChanges = (selectedTab: string | undefined) =>
  shouldRenderBareReview({ fileTreeOpen: true, fileTreeTab: "changes", selectedTab })

describe("shouldRenderBareReview", () => {
  test("keeps the diff reachable when the file tree lists the changes and review is selected", () => {
    expect(openOnChanges("review")).toBe(true)
  })

  test("keeps the diff reachable before the user has selected anything", () => {
    expect(openOnChanges(undefined)).toBe(true)
  })

  test("treats the empty placeholder as nothing selected", () => {
    expect(openOnChanges("empty")).toBe(true)
  })

  test.each(STRIP_ONLY_TABS)("keeps the strip while %p is selected", (selectedTab) => {
    expect(openOnChanges(selectedTab)).toBe(false)
  })

  test("keeps the strip for an id it cannot classify, rather than guessing", () => {
    expect(openOnChanges("something-new")).toBe(false)
  })

  test("does not apply while the file tree is closed", () => {
    expect(shouldRenderBareReview({ fileTreeOpen: false, fileTreeTab: "changes", selectedTab: "review" })).toBe(false)
    expect(shouldRenderBareReview({ fileTreeOpen: false, fileTreeTab: "changes", selectedTab: undefined })).toBe(false)
  })

  test("does not apply while the file tree lists all files rather than the changes", () => {
    expect(shouldRenderBareReview({ fileTreeOpen: true, fileTreeTab: "all", selectedTab: "review" })).toBe(false)
  })

  test("no combination drops the strip while a strip-only tab is selected", () => {
    for (const fileTreeOpen of [true, false]) {
      for (const fileTreeTab of ["changes", "all"] as const) {
        for (const selectedTab of STRIP_ONLY_TABS) {
          expect(`${fileTreeOpen}/${fileTreeTab}/${selectedTab}`).toBe(
            shouldRenderBareReview({ fileTreeOpen, fileTreeTab, selectedTab })
              ? "unreachable-tab-regression"
              : `${fileTreeOpen}/${fileTreeTab}/${selectedTab}`,
          )
        }
      }
    }
  })

  test("the shortcut is reachable at all — the previous rule could never return true", () => {
    // It required the file tree open and the *derived* active tab to be review,
    // but the derived tab is itself gated on the file tree being closed.
    expect(openOnChanges("review")).toBe(true)
  })
})
