/**
 * The two things the browser pane asks of the desktop host.
 *
 * Both resolve to nothing outside the desktop app (the browser harness,
 * tests): the pane then behaves as it did before they existed.
 */

export interface FramingHeaders {
  xFrameOptions?: string | null
  csp?: string | null
}

/** The probe's answer in the shape `framingBlocked` reads. */
export function readHeaders(headers: FramingHeaders | undefined): (name: string) => string | null {
  return (name) => {
    if (!headers) return null
    if (name === "x-frame-options") return headers.xFrameOptions ?? null
    if (name === "content-security-policy") return headers.csp ?? null
    return null
  }
}

const isDesktop = () =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

/** The page's framing headers as the host reads them, outside CORS; undefined when unknown. */
export async function probeFraming(url: string): Promise<FramingHeaders | undefined> {
  if (!isDesktop()) return undefined
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<FramingHeaders>("ade_browser_framing", { url })
  } catch {
    return undefined
  }
}

export function canOpenExternally(): boolean {
  return isDesktop()
}

/** Opens the page in the system browser; the error text when that failed. */
export async function openExternally(url: string): Promise<string | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_open_in_browser", { url })
    return undefined
  } catch (error) {
    return String(error)
  }
}

/** What «Forget this site» actually managed to delete. */
/**
 * What «Dimentica questo sito» really managed to do.
 *
 * Every field is a fact the host checked. `storageCleared` means the site's
 * storage was read back empty — not that a delete was sent: the first version
 * said "cancellati" whenever the call returned, and the data was still there
 * after a reload.
 */
export interface ForgetReport {
  /** The site's storage was read back empty afterwards. */
  storageCleared: boolean
  /** A delete was sent and nothing could be read back to check it. */
  storageUnverified: boolean
  /** How many cookies were deleted. */
  cookiesDeleted: number
  /** Whether the cookie store could be read at all. */
  cookiesReadable: boolean
  /** The storage keys that were cleared. */
  keys?: string[]
}

/**
 * The line the pane shows, which may never claim more than the report says.
 *
 * Exported because that rule is worth a test: a message that promises a
 * deletion nobody verified is the bug this whole report exists for.
 */
export type ForgetMessage =
  | { key: "browser.forget.done.all" | "browser.forget.done.cookies" | "browser.forget.unsure.cookies"; ok: boolean; cookies: number }
  | {
      key:
        | "browser.forget.done.storage"
        | "browser.forget.done.storage.noCookies"
        | "browser.forget.unsure"
        | "browser.forget.done.none"
      ok: boolean
      cookies: number
    }

export function forgetMessage(report: ForgetReport): ForgetMessage {
  const cookies = report.cookiesDeleted
  if (report.storageCleared) {
    return {
      key: cookies > 0 ? "browser.forget.done.all" : report.cookiesReadable ? "browser.forget.done.storage" : "browser.forget.done.storage.noCookies",
      ok: true,
      cookies,
    }
  }
  if (report.storageUnverified) {
    return { key: cookies > 0 ? "browser.forget.unsure.cookies" : "browser.forget.unsure", ok: false, cookies }
  }
  if (cookies > 0) return { key: "browser.forget.done.cookies", ok: true, cookies }
  return { key: "browser.forget.done.none", ok: false, cookies }
}

/** Drops cookies and site storage for `url` from ADE's profile. */
export async function forgetSite(url: string): Promise<{ report: ForgetReport; error?: undefined } | { error: string; report?: undefined }> {
  if (!isDesktop()) return { error: "non disponibile fuori dall'app" }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const report = await invoke<ForgetReport>("ade_forget_site", { url })
    return { report }
  } catch (error) {
    return { error: String(error) }
  }
}
