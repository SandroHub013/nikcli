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
    expect(summarizeCompletion([{ text: "3 passed" }], "en")).toBe("three passed tests")
    expect(summarizeCompletion([{ text: "2 failed" }], "en")).toBe("two failed tests")
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

  test("enforces hourly cap of 15 alerts with cap announcement", async () => {
    let clock = 100_000
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    // Emit 15 alerts, advancing clock by 25s each time (exceeding 20s cooldown)
    for (let i = 1; i <= 15; i++) {
      clock += 25_000
      alerts.notifyDecision(`D${i}`, `Decision ${i}`)
      await new Promise((r) => setTimeout(r, 10))
    }

    // 15 alerts + 1 cap announcement immediately following the 15th alert
    expect(spoken).toHaveLength(16)
    expect(spoken[15]).toContain("Ho raggiunto il limite di 15 avvisi")

    // 16th alert while cap is active -> dropped, nothing further spoken
    clock += 25_000
    alerts.notifyDecision("D16", "Decision 16")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(16)

    // Advance clock past 1 hour from earliest alerts (3_600_000 ms)
    clock += 3_600_000
    alerts.notifyDecision("D17", "Decision 17")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(17)
    expect(spoken[16]).toContain("Decision 17")
  })

  test("drops oldest alerts when queue exceeds MAX_QUEUE_SIZE (10)", async () => {
    let clock = 100_000
    let resolveSpeak: () => void = () => {}
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
        // Block first alert so rest stay in queue
        if (spoken.length === 1) {
          await new Promise<void>((r) => { resolveSpeak = r })
        }
      },
      openResponseWindow: async () => {},
    })

    // First alert starts processing and pauses inside speak
    alerts.notifyDecision("D0", "First")
    await new Promise((r) => setTimeout(r, 10))

    // Enqueue 15 more items while queue is blocked
    for (let i = 1; i <= 15; i++) {
      alerts.notifyDecision(`D${i}`, `Decision ${i}`)
    }

    // Queue must be capped to MAX_QUEUE_SIZE = 10
    expect(alerts.getQueueLength()).toBe(10)

    resolveSpeak()
  })

  test("prunes seenEvents older than 1 hour allowing re-notification", async () => {
    let clock = 100_000
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => false,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    alerts.notifyDecision("D1", "Stesso evento")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    // Immediate duplicate is ignored
    clock += 25_000
    alerts.notifyDecision("D1", "Stesso evento")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    // After > 1 hour (3_600_001 ms), seenEvents key is pruned
    clock += 3_600_001
    alerts.notifyDecision("D1", "Stesso evento")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(2)
  })
})
