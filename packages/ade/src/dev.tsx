/**
 * Standalone harness: mounts the ADE surface into the page's root.
 *
 * Kept apart from the surface itself so importing ADE never renders anything.
 */
import { render } from "solid-js/web"
import { AdeSurface } from "./ade-surface"
import { isTestIdentifier } from "./host/build-identity"

const root = document.getElementById("root")

/**
 * Settle the test-build mark **before** anything reads it, then render.
 *
 * `readHookStatus` answers "another build" or "an earlier ADE" by asking
 * `data-ade-build`, and `workbench.tsx` reads the hook status once, on mount.
 * So a mark written after the render loses that single read: the panel said
 * «versione precedente» about the official ADE's own hook, with «Aggiorna» and
 * «Rimuovi» live, and nothing corrected it until the settings panel was
 * touched. Codex escaped it by having no digest to compare.
 *
 * A Tauri read is a few milliseconds; the surface appearing after it costs a
 * frame and buys a panel that is right the first time. The cast is what
 * `isTestIdentifier` is for: a read that fails is not a test build, and the
 * surface still comes up.
 */
async function markTestBuild(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return
  const identifier = await import("@tauri-apps/api/app")
    .then(({ getIdentifier }) => getIdentifier())
    .catch(() => undefined)
  if (identifier === undefined) {
    // Not `adeBuild`: the hook status reads that one as «another build». The voice reads this as a test build.
    document.documentElement.dataset.adeIdentity = "unknown"
    return
  }
  if (!isTestIdentifier(identifier)) return
  document.documentElement.dataset.adeBuild = "test"
  // Set by `bun run test:app`: which worktree this instance is running.
  const label = import.meta.env.VITE_ADE_TEST_LABEL
  if (label) document.documentElement.style.setProperty("--ade-test-label", JSON.stringify(` ${label}`))
}

void markTestBuild().finally(() => {
  if (root) render(() => <AdeSurface />, root)
})
