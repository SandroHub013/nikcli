import { describe, expect, test } from "bun:test"
import {
  createProactiveAlerts,
  summarizeCompletion,
  ALERT_COOLDOWN_MS,
  RESPONSE_WINDOW_MS,
} from "./proactive-alerts"

describe("proactive-alerts", () => {
  test("summarizeCompletion extracts test counts in words", () => {
    expect(summarizeCompletion([{ text: "running..." }, { text: "3 passed" }])).toBe("tre test verdi")
    expect(summarizeCompletion([{ text: "1 pass" }])).toBe("un test verdi")
    expect(summarizeCompletion([{ text: "2 failed" }])).toBe("due test falliti")
    expect(summarizeCompletion([{ text: "just regular output" }])).toBeUndefined()
    expect(summarizeCompletion([])).toBeUndefined()
  })

  test("does nothing when proactive alerts are disabled", async () => {
    const spoken: string[] = []
    const windows: any[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => false,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async (opts) => {
        windows.push(opts)
      },
    })

    alerts.notifyPermission("p1", "Sessione 1", "rm -rf")
    alerts.notifyCompletion("p1", "Sessione 1", [{ text: "3 passed" }])
    alerts.notifyDecision("D1", "Scelta architettura")

    expect(spoken).toHaveLength(0)
    expect(windows).toHaveLength(0)
    expect(alerts.getQueueLength()).toBe(0)
  })

  test("speaks permission alert and opens response window with permission param", async () => {
    const spoken: string[] = []
    const windows: any[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async (opts) => {
        windows.push(opts)
      },
    })

    alerts.notifyPermission("p1", "Prova-voce", "bun test")
    // Wait for async queue execution
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain("Prova-voce")
    expect(spoken[0]).toContain("bun test")
    expect(spoken[0]).toContain("richiede il permesso")

    expect(windows).toHaveLength(1)
    expect(windows[0]).toEqual({
      durationMs: RESPONSE_WINDOW_MS,
      permission: { paneId: "p1", what: "bun test" },
    })
  })

  test("speaks session completion alert with summary", async () => {
    const spoken: string[] = []
    const windows: any[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async (opts) => {
        windows.push(opts)
      },
    })

    alerts.notifyCompletion("p1", "Prova-voce", [{ text: "3 passed" }], 1)
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain("Prova-voce ha finito: tre test verdi.")
    expect(windows).toHaveLength(1)
    expect(windows[0].durationMs).toBe(RESPONSE_WINDOW_MS)
  })

  test("speaks decision alert", async () => {
    const spoken: string[] = []
    const windows: any[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async (opts) => {
        windows.push(opts)
      },
    })

    alerts.notifyDecision("D42", "Tema scuro o chiaro")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain("decisione aperta")
    expect(spoken[0]).toContain("Tema scuro o chiaro")
  })

  test("deduplicates identical events", async () => {
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    alerts.notifyDecision("D1", "Prima")
    alerts.notifyDecision("D1", "Prima")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(1)
  })

  test("skips alert when PC is locked", async () => {
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => true,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    alerts.notifyPermission("p1", "Prova", "run")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(0)
  })

  test("skips stale permission when already resolved", async () => {
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
      isPermissionPending: (id) => id !== "p1", // p1 is resolved
    })

    alerts.notifyPermission("p1", "Prova", "run")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(0)
  })
})
