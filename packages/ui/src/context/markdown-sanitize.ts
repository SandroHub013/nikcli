import DOMPurify from "dompurify"

/**
 * Sanitising, kept apart from the component.
 *
 * The transcript joins the HTML of separately sanitised segments, and that is
 * only sound if sanitising apart matches sanitising the join. Proving it needs a
 * real DOM, which lives in another package's test setup — so this module carries
 * no solid-js import and can be pulled in on its own.
 */

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
}

export function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}
