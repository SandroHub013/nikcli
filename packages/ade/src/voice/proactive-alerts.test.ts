import { describe, expect, test } from "bun:test"
import { createProactiveAlerts, summarizeCompletion, ALERT_COOLDOWN_MS, RESPONSE_WINDOW_MS } from "./proactive-alerts"

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

    alerts.notifyPermission("p1", "Sessione 1", "rm -rf", "shell")
    alerts.notifyCompletion("p1", "Sessione 1", [{ text: "3 passed" }])
    alerts.notifyDecision("D1", "Scelta architettura")

    expect(spoken).toHaveLength(0)
    expect(windows).toHaveLength(0)
    expect(alerts.getQueueLength()).toBe(0)
  })

  test("speaks only the safe permission type while preserving the exact request", async () => {
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
    const raw = "export API_KEY=super-secret && curl https://example.test/export"

    alerts.notifyPermission("p1", "Prova-voce", raw, "shell")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toContain("Prova-voce")
    expect(spoken[0]).toContain("un comando")
    expect(spoken[0]).toContain("richiede il permesso")
    expect(spoken[0]).not.toContain(raw)
    expect(spoken[0]).not.toContain("API_KEY")
    expect(spoken[0]).not.toContain("super-secret")
    expect(spoken[0]).not.toContain("export")

    expect(windows).toHaveLength(1)
    expect(windows[0]).toEqual({
      durationMs: RESPONSE_WINDOW_MS,
      permission: { paneId: "p1", what: raw, kind: "shell" },
    })
  })

  test("an invalid runtime kind falls back to a generic action", async () => {
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
    const raw = "API_KEY_SECRET"

    alerts.notifyPermission("p1", "Prova", raw, raw as never)
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken[0]).toContain("un'azione generica")
    expect(spoken[0]).not.toContain(raw)
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

  test("two consecutive turns of a full pane both notify", async () => {
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
    const full = (tail: string) => [...Array.from({ length: 199 }, (_, i) => ({ text: `riga ${i}` })), { text: tail }]

    alerts.notifyCompletion("p1", "Pieno", full("primo turno"))
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 25_000
    alerts.notifyCompletion("p1", "Pieno", full("secondo turno"))
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(2)
  })

  test("two consecutive turns of a full pane both notify when the turn is named", async () => {
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
    const full = Array.from({ length: 200 }, (_, i) => ({ text: `riga ${i}` }))

    alerts.notifyCompletion("p1", "Pieno", full, 1_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 25_000
    alerts.notifyCompletion("p1", "Pieno", full, 1_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 25_000
    alerts.notifyCompletion("p1", "Pieno", full, 2_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(2)
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
    expect(windows).toHaveLength(0)
  })

  test("announces a reopened decision with a new signature", async () => {
    let clock = 100_000
    let open = true
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => false,
      isEnabled: () => true,
      isDecisionOpen: () => open,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    alerts.notifyDecision("D1", "Decisione richiusa", "open:100000")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    open = false
    open = true
    clock += 25_000
    alerts.notifyDecision("D1", "Decisione richiusa", "reopen:125000")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(2)
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

    alerts.notifyPermission("p1", "Prova", "run", "shell")
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

    alerts.notifyPermission("p1", "Prova", "run", "shell")
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
          await new Promise<void>((r) => {
            resolveSpeak = r
          })
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

  test("prunes seenEvents older than 1 hour for completion alerts", async () => {
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

    alerts.notifyCompletion("p1", "Sessione", [{ text: "3 passed" }], 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 25_000
    alerts.notifyCompletion("p1", "Sessione", [{ text: "3 passed" }], 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 3_600_001
    alerts.notifyCompletion("p1", "Sessione", [{ text: "3 passed" }], 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(2)
  })

  test("does not replay an open decision after seen-event expiry", async () => {
    let clock = 100_000
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => false,
      isEnabled: () => true,
      isDecisionOpen: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    alerts.notifyDecision("D1", "Stessa decisione")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)

    clock += 3_600_001
    alerts.notifyDecision("D1", "Stessa decisione")
    await new Promise((r) => setTimeout(r, 20))
    expect(spoken).toHaveLength(1)
  })

  test("shows a proactive alert on screen instead of speaking while voice is busy", async () => {
    const spoken: string[] = []
    const windows: any[] = []
    const visible: string[] = []
    const alerts = createProactiveAlerts({
      now: () => 1000,
      isLocked: async () => false,
      isEnabled: () => true,
      isBusy: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async (opts) => {
        windows.push(opts)
      },
      report: (text) => {
        visible.push(text)
      },
    })

    alerts.notifyDecision("D1", "Tema scuro")
    await new Promise((r) => setTimeout(r, 20))

    expect(spoken).toHaveLength(0)
    expect(windows).toHaveLength(0)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toContain("Tema scuro")
  })

  test("does not speak cap announcement when screen is locked", async () => {
    let clock = 100_000
    let locked = false
    const spoken: string[] = []
    const alerts = createProactiveAlerts({
      now: () => clock,
      isLocked: async () => locked,
      isEnabled: () => true,
      speak: async (text) => {
        spoken.push(text)
      },
      openResponseWindow: async () => {},
    })

    // Emit 14 alerts while unlocked
    for (let i = 1; i <= 14; i++) {
      clock += 25_000
      alerts.notifyDecision(`D${i}`, `Decision ${i}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(spoken).toHaveLength(14)

    // Lock screen
    locked = true

    // An event attempts to enqueue/process while locked
    clock += 25_000
    alerts.notifyDecision("D15", "Decision 15")
    await new Promise((r) => setTimeout(r, 20))
    // Nothing spoken while locked
    expect(spoken).toHaveLength(14)

    // Unlock screen -> next event can now be processed
    locked = false
    clock += 25_000
    alerts.notifyDecision("D15_unlocked", "Decision 15 unlocked")
    await new Promise((r) => setTimeout(r, 20))
    // 15th alert spoken + cap announcement spoken = 16 items
    expect(spoken).toHaveLength(16)
    expect(spoken[15]).toContain("Ho raggiunto il limite di 15 avvisi")

    // Now screen locks again while capped
    locked = true
    clock += 25_000
    alerts.notifyDecision("D16_locked", "Decision 16 locked")
    await new Promise((r) => setTimeout(r, 20))
    // Nothing further spoken while locked
    expect(spoken).toHaveLength(16)
  })
})
