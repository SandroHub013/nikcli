/**
 * Fidelity state machine and handshake reducer for the browser pane.
 *
 * An inspected page can run in three fidelity tiers:
 *
 * 1. "native": The page loaded on its own origin and announced the bridge within
 *    the handshake window. Relative assets and client-side routing work identically
 *    to a standalone browser tab.
 * 2. "mirror": The page did not announce the bridge before timeout, so the pane
 *    fetched the HTML and injected the bridge into an `about:srcdoc` iframe.
 * 3. "none": Neither native nor mirror inspection is available (e.g. cross-origin
 *    server with no CORS headers, or server unreachable). The frame is either
 *    browse-only without element inspection or in an error state.
 *
 * Modeling this as a pure reducer over discrete events allows testing the full
 * lifecycle and edge cases without mounting a DOM or running asynchronous timers.
 */

export type Fidelity = "pending" | "native" | "mirror" | "none"

/**
 * How long (in ms) to wait for a page to announce the bridge before falling back
 * to a mirrored copy. 1500ms provides enough time for a cold dev server to compile
 * and execute the bridge script without delaying fallback too long.
 */
export const HANDSHAKE_TIMEOUT_MS = 1500

export type HandshakeEvent =
  | { type: "navigate"; url?: string }
  | { type: "ready"; mode?: "native" | "mirror" }
  | { type: "timeout" }
  | { type: "load-error"; error?: string }

export interface HandshakeState {
  fidelity: Fidelity
  error?: string
}

export const INITIAL_HANDSHAKE_STATE: HandshakeState = {
  fidelity: "pending",
}

/**
 * Pure state reducer managing the fidelity handshake lifecycle.
 */
export function handshakeReducer(
  state: HandshakeState,
  event: HandshakeEvent,
): HandshakeState {
  switch (event.type) {
    case "navigate": {
      // Navigating to a new target always restarts the handshake from scratch.
      return {
        fidelity: "pending",
        error: undefined,
      }
    }

    case "ready": {
      // If the bridge announces itself, promote to native (or mirror if explicitly flagged).
      const nextFidelity: Fidelity = event.mode ?? (state.fidelity === "mirror" ? "mirror" : "native")
      return {
        fidelity: nextFidelity,
        error: undefined,
      }
    }

    case "timeout": {
      // A timeout only demotes a pending state to mirror fallback.
      // Once already native or resolved, a late timer trigger is a no-op.
      if (state.fidelity === "pending") {
        return {
          fidelity: "mirror",
          error: undefined,
        }
      }
      return state
    }

    case "load-error": {
      // When fetching or loading fails completely, inspection is unavailable.
      return {
        fidelity: "none",
        error: event.error,
      }
    }

    default:
      return state
  }
}

/**
 * Convenience helper reducing just the fidelity enum value.
 */
export function reduceFidelity(fidelity: Fidelity, event: HandshakeEvent): Fidelity {
  return handshakeReducer({ fidelity }, event).fidelity
}
