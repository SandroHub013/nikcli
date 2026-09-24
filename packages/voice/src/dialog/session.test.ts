import { describe, expect, test } from "bun:test"
import {
  createInitialDialogState,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  transition,
} from "./session"

describe("dialog state machine", () => {
  describe("wake and sleep cycles", () => {
    test("wakes from sleep on wake event", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(s0, { type: "wake" }, 1000)

      expect(s1.status).toBe("idle")
      expect(effects.some((e) => e.type === "speak" && e.text.includes("sveglio"))).toBe(true)
    })

    test("wakes from sleep on spoken wake utterance", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(s0, { type: "utterance", text: "svegliati" }, 1000)

      expect(s1.status).toBe("idle")
      expect(effects.some((e) => e.type === "speak")).toBe(true)
    })

    test("ignores normal commands while asleep", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "nuova sessione" },
        1000
      )

      expect(s1.status).toBe("asleep")
      expect(effects.length).toBe(0)
    })

    test("goes to sleep on sleep utterance", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "vai a dormire" }, 1000)

      expect(s1.status).toBe("asleep")
    })
  })

  describe("destructive actions confirmation flow", () => {
    test("destructive intent 'uccidi processo' requires confirmation and does not execute directly", () => {
      const s0 = createInitialDialogState("idle")
      const now = 10_000
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "uccidi processo" },
        now
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction).toBeDefined()
      expect(s1.pendingAction?.intent.intent).toBe("process.kill")
      expect(s1.timeoutAt).toBe(now + DEFAULT_CONFIRMATION_TIMEOUT_MS)

      // Must start timer
      expect(effects.some((e) => e.type === "start_timer")).toBe(true)
      // Must NOT execute directly
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
      // Must warn user
      // Must ask about this action by name, as a question — not restate the
      // readback, which is a statement and reads as broken Italian in a prompt.
      expect(
        effects.some(
          (e) => e.type === "speak" && e.text.includes("Fermo il processo") && e.text.includes("?")
        )
      ).toBe(true)
    })

    test("confirming a destructive action with 'si' executes the intent", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )

      expect(s1.status).toBe("confirming")

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "si" },
        12_000
      )

      expect(s2.status).toBe("executing")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "cancel_timer")).toBe(true)
      const execEffect = e2.find((e) => e.type === "execute_intent")
      expect(execEffect).toBeDefined()
      if (execEffect && execEffect.type === "execute_intent") {
        expect(execEffect.intent.intent).toBe("pane.close")
        expect(execEffect.slots.paneIndex).toBe(2)
      }
    })

    test("cancelling a destructive action with 'annulla' returns to idle without executing", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "uccidi processo" },
        10_000
      )

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "annulla" },
        12_000
      )

      expect(s2.status).toBe("idle")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "cancel_timer")).toBe(true)
      expect(e2.some((e) => e.type === "execute_intent")).toBe(false)
    })

    test("timeout during confirmation automatically aborts to idle", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello" },
        10_000
      )

      const timeoutTime = 10_000 + DEFAULT_CONFIRMATION_TIMEOUT_MS + 1
      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "timeout" },
        timeoutTime
      )

      expect(s2.status).toBe("idle")
      expect(s2.pendingAction).toBeUndefined()
      expect(e2.some((e) => e.type === "execute_intent")).toBe(false)
      expect(e2.some((e) => e.type === "speak" && e.text.includes("lascio stare"))).toBe(true)
    })
  })

  /*
   * Rilievo 1 della review: «non confermo» e «no, non va bene» superavano la
   * soglia come dialog.confirm, perché «non» è solo un'eccedenza che toglie
   * 0,15. Una negazione deve annullare la conferma, non eseguirla.
   */
  describe("una negazione non conferma mai", () => {
    test("«non confermo» non esegue l'azione in conferma", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "chiudi pannello 2" }, 10_000)
      expect(s1.status).toBe("confirming")

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "non confermo" }, 12_000)

      expect(s2.status).toBe("idle")
      expect(s2.pendingAction).toBeUndefined()
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
      expect(effects.some((e) => e.type === "cancel_timer")).toBe(true)
    })

    test("«no, non va bene» annulla invece di confermare", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "uccidi processo" }, 10_000)
      expect(s1.status).toBe("confirming")

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "no, non va bene" }, 12_000)

      expect(s2.status).toBe("idle")
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
      expect(
        effects.some((e) => e.type === "speak" && e.text.includes("lascio stare"))
      ).toBe(true)
    })

    test("«non consentire» nega il permesso invece di concederlo", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "rm -rf tmp" },
        5000
      )
      expect(s1.status).toBe("confirming")

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "non consentire" }, 6000)

      expect(s2.status).toBe("idle")
      const ans = effects.find((e) => e.type === "answer_permission")
      expect(ans).toBeDefined()
      if (ans && ans.type === "answer_permission") {
        expect(ans.answer).toBe("deny")
      }
      expect(effects.some((e) => e.type === "answer_permission" && e.answer === "allow")).toBe(false)
    })

    test("«non chiudere» non chiude il pannello in conferma", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "chiudi pannello 2" }, 10_000)
      expect(s1.status).toBe("confirming")

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "non chiudere" }, 12_000)

      expect(s2.status).toBe("idle")
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
    })
  })

  describe("dictation mode", () => {
    test("accumulates text without interpreting as commands until finish phrase", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "utterance", text: "inizia dettatura pannello 1" },
        1000
      )

      expect(s1.status).toBe("dictating")
      expect(s1.dictation).toBeDefined()
      expect(s1.dictation?.paneId).toBe("1")
      expect(e1.some((e) => e.type === "speak")).toBe(true)

      // Speak words that would normally be commands
      const { state: s2 } = transition(
        s1,
        { type: "utterance", text: "crea un test e chiudi il pannello" },
        2000
      )
      expect(s2.status).toBe("dictating")
      expect(s2.dictation?.chunks).toEqual(["crea un test e chiudi il pannello"])

      const { state: s3 } = transition(
        s2,
        { type: "utterance", text: "poi aggiungi la funzione di login" },
        3000
      )
      expect(s3.dictation?.chunks).toEqual([
        "crea un test e chiudi il pannello",
        "poi aggiungi la funzione di login",
      ])

      // Finish dictation
      const { state: s4, effects: e4 } = transition(
        s3,
        { type: "utterance", text: "fine dettatura" },
        4000
      )

      expect(s4.status).toBe("idle")
      expect(s4.dictation).toBeUndefined()
      const promptEffect = e4.find((e) => e.type === "send_prompt")
      expect(promptEffect).toBeDefined()
      if (promptEffect && promptEffect.type === "send_prompt") {
        expect(promptEffect.paneId).toBe("1")
        expect(promptEffect.text).toBe(
          "crea un test e chiudi il pannello poi aggiungi la funzione di login"
        )
      }
    })
  })

  /*
   * Rilievo 2: permission.allow era non distruttivo, quindi «autorizza» o
   * «consenti» detti in idle eseguivano subito answerPermission. Ora la
   * conferma deve chiedere prima, nominando pannello e strumento.
   */
  describe("permission.allow free-standing requires confirmation", () => {
    test("«autorizza» in idle enters confirming and does not answer the permission", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "autorizza" },
        10_000
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.intent.intent).toBe("permission.allow")
      expect(effects.some((e) => e.type === "answer_permission")).toBe(false)
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
      expect(effects.some((e) => e.type === "start_timer")).toBe(true)
    })

    test("«consenti» confirmed with «sì» then answers the permission", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "consenti pannello 1" }, 10_000)
      expect(s1.status).toBe("confirming")

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "sì" }, 12_000)
      expect(s2.status).toBe("executing")
      const exec = effects.find((e) => e.type === "execute_intent")
      expect(exec).toBeDefined()
      if (exec && exec.type === "execute_intent") {
        expect(exec.intent.intent).toBe("permission.allow")
        expect(exec.slots.paneIndex).toBe(1)
      }
    })
  })

  describe("permission confirmation names panel and instrument", () => {
    test("permission request prompt names the panel title and the tool", () => {
      const s0 = createInitialDialogState("idle")
      const panes = [
        {
          id: "agent-1",
          title: "API Tests",
          status: "waiting" as const,
          index: 1,
          hasLiveProcess: false,
          isBrowser: false,
          isFile: false,
        },
      ]
      const { state: s1, effects } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "rm -rf tmp" },
        5000,
        { panes }
      )

      expect(s1.status).toBe("confirming")
      const speak = effects.find((e) => e.type === "speak")
      expect(speak).toBeDefined()
      if (speak && speak.type === "speak") {
        expect(speak.text).toContain("API Tests")
        expect(speak.text).toContain("rm -rf tmp")
      }
      expect(s1.pendingAction?.confirmPrompt).toContain("API Tests")
      expect(s1.pendingAction?.confirmPrompt).toContain("rm -rf tmp")
    })

    test("free-standing permission.allow confirmation names the panel when known", () => {
      const s0 = createInitialDialogState("idle")
      const panes = [
        {
          id: "pane-2",
          title: "Bastelli Worker",
          status: "working" as const,
          index: 2,
          hasLiveProcess: true,
          isBrowser: false,
          isFile: false,
        },
      ]
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "autorizza pannello 2" },
        10_000,
        { panes }
      )

      expect(s1.status).toBe("confirming")
      const speak = effects.find((e) => e.type === "speak")
      expect(speak).toBeDefined()
      if (speak && speak.type === "speak") {
        expect(speak.text).toContain("Bastelli Worker")
        expect(speak.text).toContain("?")
      }
    })

    /*
     * Rilievo 21: la conferma di una chiusura diceva solo «il pannello»,
     * senza il nome, così l'utente sì sul bersaglio sbagliato non aveva
     * come accorgersene. Il titolo c'è già negli slot o nei pannelli aperti.
     */
    test("pane.close confirmation names the panel title", () => {
      const s0 = createInitialDialogState("idle")
      const panes = [
        {
          id: "pane-1",
          title: "Bastelli",
          status: "idle" as const,
          index: 1,
          hasLiveProcess: false,
          isBrowser: false,
          isFile: false,
        },
        {
          id: "pane-2",
          title: "API Tests",
          status: "working" as const,
          index: 2,
          hasLiveProcess: true,
          isBrowser: false,
          isFile: false,
        },
      ]
      const { state: s1, effects } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000,
        { panes }
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.confirmPrompt).toContain("API Tests")
      const speak = effects.find((e) => e.type === "speak")
      expect(speak).toBeDefined()
      if (speak && speak.type === "speak") {
        expect(speak.text).toContain("API Tests")
      }
    })

    test("process.kill confirmation names the panel title when the index is known", () => {
      const s0 = createInitialDialogState("idle")
      const panes = [
        {
          id: "pane-1",
          title: "Bastelli",
          status: "working" as const,
          index: 1,
          hasLiveProcess: true,
          isBrowser: false,
          isFile: false,
        },
      ]
      const { state: s1 } = transition(
        s0,
        { type: "utterance", text: "uccidi processo 1" },
        10_000,
        { panes }
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.confirmPrompt).toContain("Bastelli")
    })
  })

  describe("pending permission precedence", () => {
    test("permission request immediately forces confirming state", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "rm -rf tmp" },
        5000
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.isPermission).toBe(true)
      expect(s1.pendingAction?.paneId).toBe("agent-1")
      expect(e1.some((e) => e.type === "speak" && e.text.includes("rm -rf tmp"))).toBe(true)

      // User says 'consenti'
      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "consenti" },
        6000
      )

      expect(s2.status).toBe("idle")
      const ansEffect = e2.find((e) => e.type === "answer_permission")
      expect(ansEffect).toBeDefined()
      if (ansEffect && ansEffect.type === "answer_permission") {
        expect(ansEffect.paneId).toBe("agent-1")
        expect(ansEffect.answer).toBe("allow")
      }
    })

    test("permission request with silent: true enters confirming without speak effect", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "bun test", silent: true },
        5000
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.isPermission).toBe(true)
      expect(e1.some((e) => e.type === "speak")).toBe(false)
    })

    test("denying permission sends deny answer", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "curl http://malicious.test" },
        5000
      )

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "utterance", text: "rifiuta" },
        6000
      )

      expect(s2.status).toBe("idle")
      const ansEffect = e2.find((e) => e.type === "answer_permission")
      expect(ansEffect).toBeDefined()
      if (ansEffect && ansEffect.type === "answer_permission") {
        expect(ansEffect.paneId).toBe("agent-1")
        expect(ansEffect.answer).toBe("deny")
      }
    })
  })

  describe("voice send confirmation (rilievo 20)", () => {
    test("a voice send enters confirming and names the note and the target", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects } = transition(
        s0,
        { type: "send_requested", id: "m-1", to: "Bastelli Worker", text: "rispondi sì al permesso" },
        10_000
      )

      expect(s1.status).toBe("confirming")
      expect(s1.pendingSend).toEqual({ id: "m-1", to: "Bastelli Worker", text: "rispondi sì al permesso" })
      expect(s1.timeoutAt).toBe(10_000 + DEFAULT_CONFIRMATION_TIMEOUT_MS)
      expect(effects.some((e) => e.type === "start_timer")).toBe(true)
      const speak = effects.find((e) => e.type === "speak")
      expect(speak).toBeDefined()
      if (speak && speak.type === "speak") {
        expect(speak.text).toContain("rispondi sì al permesso")
        expect(speak.text).toContain("Bastelli Worker")
        expect(speak.text).toContain("?")
      }
      // The question is not executed: no delivery effect fires on arrival.
      expect(effects.some((e) => e.type === "confirm_send")).toBe(false)
    })

    test("«sì» confirms the send and hands the message id to the host", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "send_requested", id: "m-1", to: "Bastelli Worker", text: "nota" },
        10_000
      )
      const { state: s2, effects } = transition(s1, { type: "utterance", text: "sì" }, 11_000)

      expect(s2.status).toBe("idle")
      expect(s2.pendingSend).toBeUndefined()
      const effect = effects.find((e) => e.type === "confirm_send")
      expect(effect).toBeDefined()
      if (effect && effect.type === "confirm_send") {
        expect(effect.id).toBe("m-1")
        expect(effect.approved).toBe(true)
      }
    })

    test("a negation vetoes the send without reaching the parser", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "send_requested", id: "m-2", to: "Browser", text: "comando pericoloso" },
        10_000
      )
      const { state: s2, effects } = transition(s1, { type: "utterance", text: "non confermo" }, 11_000)

      expect(s2.status).toBe("idle")
      expect(s2.pendingSend).toBeUndefined()
      const effect = effects.find((e) => e.type === "confirm_send")
      expect(effect).toBeDefined()
      if (effect && effect.type === "confirm_send") {
        expect(effect.id).toBe("m-2")
        expect(effect.approved).toBe(false)
      }
      expect(effects.some((e) => e.type === "execute_intent")).toBe(false)
    })

    test("the send times out unapproved, like any other confirmation", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(
        s0,
        { type: "send_requested", id: "m-3", to: "Codex", text: "nota" },
        10_000
      )
      const { state: s2, effects } = transition(s1, { type: "timeout" }, 10_000 + DEFAULT_CONFIRMATION_TIMEOUT_MS)

      expect(s2.status).toBe("idle")
      expect(s2.pendingSend).toBeUndefined()
      const effect = effects.find((e) => e.type === "confirm_send")
      expect(effect).toBeDefined()
      if (effect && effect.type === "confirm_send") {
        expect(effect.id).toBe("m-3")
        expect(effect.approved).toBe(false)
      }
    })
  })

  describe("permission request while the dialog is busy (rilievo 3)", () => {
    test("during confirming: queues without replacing the pending action, then promotes after the answer", () => {
      // User asked to close pane 2; confirmation is in flight.
      const s0 = createInitialDialogState("idle")
      const { state: confirming } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )
      expect(confirming.status).toBe("confirming")
      expect(confirming.pendingAction?.intent.intent).toBe("pane.close")

      // A permission arrives mid-confirmation: must queue, not replace.
      const { state: s1, effects: e1 } = transition(
        confirming,
        { type: "permission_requested", paneId: "agent-3", what: "rm -rf build" },
        11_000
      )
      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.intent.intent).toBe("pane.close")
      expect(s1.queuedPermission).toEqual({
        paneId: "agent-3",
        what: "rm -rf build",
        silent: undefined,
      })
      expect(
        e1.some((e) => e.type === "speak" && e.text.includes("rm -rf build"))
      ).toBe(true)
      expect(e1.some((e) => e.type === "answer_permission")).toBe(false)

      // User confirms the close: executes, does NOT answer the permission yet.
      const { state: s2, effects: e2 } = transition(s1, { type: "utterance", text: "sì" }, 12_000)
      expect(s2.status).toBe("executing")
      expect(e2.some((e) => e.type === "execute_intent" && e.intent.intent === "pane.close")).toBe(true)
      expect(e2.some((e) => e.type === "answer_permission")).toBe(false)
      expect(s2.queuedPermission?.paneId).toBe("agent-3")

      // Execution finishes: the queued permission is promoted to confirming.
      const { state: s3, effects: e3 } = transition(s2, { type: "command_success" }, 13_000)
      expect(s3.status).toBe("confirming")
      expect(s3.pendingAction?.isPermission).toBe(true)
      expect(s3.pendingAction?.paneId).toBe("agent-3")
      expect(s3.queuedPermission).toBeUndefined()
      expect(
        e3.some((e) => e.type === "speak" && e.text.includes("rm -rf build"))
      ).toBe(true)
      expect(e3.some((e) => e.type === "start_timer")).toBe(true)
    })

    test("during confirming: a denied confirmation still promotes the queued permission", () => {
      const s0 = createInitialDialogState("idle")
      const { state: confirming } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )
      const { state: s1 } = transition(
        confirming,
        { type: "permission_requested", paneId: "agent-3", what: "curl evil.test" },
        11_000
      )
      expect(s1.queuedPermission).toBeDefined()

      const { state: s2, effects } = transition(s1, { type: "utterance", text: "no" }, 12_000)
      expect(s2.status).toBe("confirming")
      expect(s2.pendingAction?.isPermission).toBe(true)
      expect(s2.pendingAction?.paneId).toBe("agent-3")
      expect(s2.queuedPermission).toBeUndefined()
      expect(effects.some((e) => e.type === "speak" && e.text.includes("curl evil.test"))).toBe(true)
    })

    test("during dictating: queues, keeps the buffer, promotes when dictation finishes", () => {
      const s0 = createInitialDialogState("idle")
      const { state: dictating } = transition(
        s0,
        { type: "utterance", text: "inizia dettatura pannello 1" },
        1000
      )
      const { state: s1 } = transition(
        dictating,
        { type: "utterance", text: "crea un test" },
        2000
      )

      const { state: s2, effects: e2 } = transition(
        s1,
        { type: "permission_requested", paneId: "agent-9", what: "npm publish" },
        3000
      )
      expect(s2.status).toBe("dictating")
      expect(s2.dictation?.chunks).toEqual(["crea un test"])
      expect(s2.queuedPermission?.paneId).toBe("agent-9")
      expect(e2.some((e) => e.type === "speak" && e.text.includes("npm publish"))).toBe(true)
      // The dictation must not be sent or dropped by the permission.
      expect(e2.some((e) => e.type === "send_prompt")).toBe(false)

      const { state: s3, effects: e3 } = transition(
        s2,
        { type: "utterance", text: "fine dettatura" },
        4000
      )
      expect(e3.some((e) => e.type === "send_prompt" && e.text === "crea un test")).toBe(true)
      expect(s3.status).toBe("confirming")
      expect(s3.dictation).toBeUndefined()
      expect(s3.pendingAction?.isPermission).toBe(true)
      expect(s3.pendingAction?.paneId).toBe("agent-9")
      expect(s3.queuedPermission).toBeUndefined()
      expect(e3.some((e) => e.type === "speak" && e.text.includes("npm publish"))).toBe(true)
    })

    test("during asleep: announces, stays asleep, promotes on wake", () => {
      const s0 = createInitialDialogState("asleep")
      const { state: s1, effects: e1 } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "sudo apt install" },
        5000
      )

      // Stays asleep: room noise must not open a 30 s granting window.
      expect(s1.status).toBe("asleep")
      expect(s1.pendingAction).toBeUndefined()
      expect(s1.queuedPermission?.paneId).toBe("agent-1")
      expect(
        e1.some((e) => e.type === "speak" && e.text.includes("sudo apt install"))
      ).toBe(true)

      const { state: s2, effects: e2 } = transition(s1, { type: "wake" }, 6000)
      expect(s2.status).toBe("confirming")
      expect(s2.pendingAction?.isPermission).toBe(true)
      expect(s2.pendingAction?.paneId).toBe("agent-1")
      expect(s2.queuedPermission).toBeUndefined()
      expect(e2.some((e) => e.type === "speak" && e.text.includes("sudo apt install"))).toBe(true)
      expect(e2.some((e) => e.type === "start_timer")).toBe(true)
    })

    test("silent permission during confirming queues without speaking", () => {
      const s0 = createInitialDialogState("idle")
      const { state: confirming } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )
      const { state: s1, effects: e1 } = transition(
        confirming,
        { type: "permission_requested", paneId: "agent-3", what: "git push --force", silent: true },
        11_000
      )
      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.intent.intent).toBe("pane.close")
      expect(s1.queuedPermission?.paneId).toBe("agent-3")
      expect(s1.queuedPermission?.silent).toBe(true)
      expect(e1.some((e) => e.type === "speak")).toBe(false)
    })

    test("a second permission while one is already queued keeps the first", () => {
      const s0 = createInitialDialogState("idle")
      const { state: confirming } = transition(
        s0,
        { type: "utterance", text: "chiudi pannello 2" },
        10_000
      )
      const { state: s1 } = transition(
        confirming,
        { type: "permission_requested", paneId: "agent-a", what: "first tool" },
        11_000
      )
      const { state: s2 } = transition(
        s1,
        { type: "permission_requested", paneId: "agent-b", what: "second tool" },
        11_500
      )
      expect(s2.queuedPermission?.paneId).toBe("agent-a")
      expect(s2.pendingAction?.intent.intent).toBe("pane.close")
    })

    test("idle permission still takes the floor immediately (not queued)", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1, effects } = transition(
        s0,
        { type: "permission_requested", paneId: "agent-1", what: "rm -rf tmp" },
        5000
      )
      expect(s1.status).toBe("confirming")
      expect(s1.pendingAction?.isPermission).toBe(true)
      expect(s1.queuedPermission).toBeUndefined()
      expect(effects.some((e) => e.type === "speak" && e.text.includes("rm -rf tmp"))).toBe(true)
    })
  })

  describe("repeat last spoken", () => {
    test("repeats the last message spoken by the system", () => {
      const s0 = createInitialDialogState("idle")
      const { state: s1 } = transition(s0, { type: "utterance", text: "apri browser" }, 1000)
      expect(s1.lastSpokenText).toBeDefined()

      // Execution completes
      const { state: s1Done } = transition(s1, { type: "command_success" }, 1500)

      const { effects: e2 } = transition(s1Done, { type: "utterance", text: "ripeti" }, 2000)
      const repeatEffect = e2.find((e) => e.type === "speak")
      expect(repeatEffect?.text).toBe(s1.lastSpokenText!)
    })
  })
})
