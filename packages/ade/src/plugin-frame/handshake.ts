/**
 * Who gets the port.
 *
 * The frame's origin is opaque, so no `targetOrigin` can name it and the port
 * has to be offered to `"*"`. What decides who receives it instead is a secret
 * the plugin proves it knows: ADE puts a fresh nonce in the frame's URL (in the
 * fragment, which no server and no `Referer` ever sees), the plugin reads it
 * from its own address and sends it back in a `hello`, and only a `hello` from
 * that frame's window with that nonce is answered with the port.
 *
 * A page the frame navigates to has not got the nonce: it is not the plugin, it
 * says no `hello` that counts, and it gets no port. What happens to the port
 * that belonged to the document before it is `link.ts`'s probe: every `load`
 * of the frame asks the link a question only the live document can answer.
 */

/** The message that hands the plugin its port; the port travels with it. */
export const PORT_OFFER = "plugin:port"

/** The plugin → ADE message that carries the nonce. */
export const HELLO = "plugin:hello"

/** A fresh secret for one load of the frame: 24 random bytes as hex. */
export function newNonce(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The shortest nonce believed: anything shorter is not one ADE made. */
export const MIN_NONCE = 32

export type HelloVerdict = { ok: true } | { ok: false; reason: string; fromFrame: boolean }

export function createHandshake(deps: {
  /** The window of the frame ADE made, if it is there. */
  frameWindow: () => unknown
  /** The nonce in the URL of the frame that is loaded now. */
  nonce: () => string
}) {
  return {
    /** A `message` arrived on ADE's window: whether it is the plugin's hello, and so gets the port. */
    hello(event: { source: unknown; data: unknown }): HelloVerdict {
      const frame = deps.frameWindow()
      const fromFrame = frame !== undefined && frame !== null && event.source === frame
      // Anything from another window is not this frame's business, and not worth a line.
      if (!fromFrame) return { ok: false, reason: "non viene dal frame del mondo", fromFrame }
      const data = event.data as { type?: unknown; nonce?: unknown } | null
      if (!data || typeof data !== "object" || data.type !== HELLO)
        return { ok: false, reason: "messaggio del frame che non è un hello", fromFrame }
      const expected = deps.nonce()
      if (typeof data.nonce !== "string" || expected.length < MIN_NONCE || data.nonce !== expected)
        return { ok: false, reason: "hello senza il nonce giusto: il frame non è il mondo", fromFrame }
      return { ok: true }
    },
  }
}
