/**
 * Standalone harness: mounts the ADE surface into the page's root.
 *
 * Kept apart from the surface itself so importing ADE never renders anything.
 */
import { render } from "solid-js/web"
import { AdeSurface } from "./ade-surface"

const root = document.getElementById("root")
if (root) render(() => <AdeSurface />, root)
