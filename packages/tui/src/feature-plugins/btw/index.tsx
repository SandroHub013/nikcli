import type { TuiPlugin, TuiPluginModule } from "@nikcli-ai/plugin/tui"
import { createStore, produce } from "solid-js/store"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { friendlyErrorMessage } from "../../util/error-message"
import { BtwDialog, type BtwActions, type BtwEntry } from "./dialog"

// `session.generate` sends the session's tool definitions (so the request
// shares the turn's prompt cache) but runs no tool loop: a tool call would
// surface as an empty answer.
const INSTRUCTIONS = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

/** Answers kept per session. The oldest settled one goes first; a pending one is never dropped. */
const HISTORY_LIMIT = 20

type Target = { sessionID: string; workspace?: string; directory: string }

/**
 * `/btw <question>`: a one-shot answer from the session's context and model
 * that is never added to the conversation (see `SessionPrompt.generate`).
 *
 * Every answer lands in a per-session history the dialog can page through, so
 * closing the dialog loses nothing: a pending request keeps running and a
 * toast says when it is ready. From the dialog an answer can be copied,
 * retried, discarded, or carried into a fork of the session as a finished turn
 * — the only way a side answer ever enters a conversation, and a separate one.
 */
const tui: TuiPlugin = async (api) => {
  let disposed = false
  let nextID = 0
  /** Which session's history the open dialog shows, if one is open. */
  let showing: string | undefined
  const controllers = new Map<number, AbortController>()
  const [history, setHistory] = createStore<Record<string, BtwEntry[]>>({})

  const entries = (sessionID: string) => history[sessionID] ?? []

  const target = (): Target | undefined => {
    const route = api.route.current
    if (route.name !== "session" || typeof route.params?.sessionID !== "string") return
    const sessionID = route.params.sessionID
    const session = api.data.session.get(sessionID)
    const routeWorkspace = typeof route.params.workspaceID === "string" ? route.params.workspaceID : undefined
    return {
      sessionID,
      // Same precedence as the prompt's `sessionRequestContext`, so the call
      // reaches the instance the session's own turns run in.
      workspace: routeWorkspace ?? session?.workspaceID,
      directory: session?.directory ?? api.state.path.directory,
    }
  }

  const update = (sessionID: string, id: number, patch: Partial<BtwEntry>) =>
    setHistory(sessionID, (entry) => entry.id === id, patch)

  const request = (where: Target, id: number, question: string) => {
    controllers.get(id)?.abort()
    const controller = new AbortController()
    controllers.set(id, controller)
    const startedAt = Date.now()
    update(where.sessionID, id, {
      status: "pending",
      startedAt,
      text: undefined,
      error: undefined,
      elapsed: undefined,
      agent: undefined,
      model: undefined,
      finish: undefined,
    })
    void api.client.session
      .generate(
        {
          sessionID: where.sessionID,
          directory: where.directory,
          workspace: where.workspace,
          prompt: `${INSTRUCTIONS}\n\n${question}`,
        },
        { signal: controller.signal },
      )
      .then(({ data, error, response }) => {
        if (disposed || controller.signal.aborted) return
        const elapsed = Date.now() - startedAt
        if (error || !data) {
          update(where.sessionID, id, { status: "error", error: failureMessage(error, response?.status), elapsed })
          return
        }
        if (!data.text) {
          update(where.sessionID, id, {
            status: "error",
            error: "The model tried to use a tool instead of answering. Retry or rephrase the question.",
            elapsed,
          })
          return
        }
        update(where.sessionID, id, {
          status: "done",
          text: data.text,
          agent: data.agent,
          model: data.model,
          finish: data.finish,
          elapsed,
        })
        if (showing !== where.sessionID) {
          api.ui.toast({
            variant: "success",
            title: "/btw answer ready",
            message: "Open it with the “Side question history” command.",
          })
        }
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return
        update(where.sessionID, id, { status: "error", error: failureMessage(error), elapsed: Date.now() - startedAt })
      })
      .finally(() => {
        if (controllers.get(id) === controller) controllers.delete(id)
      })
  }

  const ask = (question: string) => {
    const where = target()
    if (!where) {
      api.ui.toast({ variant: "warning", message: "Open a session to ask a side question" })
      return
    }
    const id = ++nextID
    setHistory(
      produce((all) => {
        const list = [...(all[where.sessionID] ?? [])]
        list.push({ id, sessionID: where.sessionID, question, status: "pending", startedAt: Date.now() })
        while (list.length > HISTORY_LIMIT) {
          const drop = list.findIndex((entry) => entry.status !== "pending")
          if (drop === -1) break
          list.splice(drop, 1)
        }
        all[where.sessionID] = list
      }),
    )
    request(where, id, question)
    open(where.sessionID, id)
  }

  const promptForQuestion = (back?: () => void) => {
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="/btw"
        placeholder="Ask a side question about this session"
        description={() => <text>Answered from the session's context; never added to the conversation.</text>}
        back={back}
        onConfirm={(value) => ask(value)}
      />
    ))
  }

  const actions: BtwActions = {
    entries,
    retry(entry) {
      const where = target()
      if (!where || where.sessionID !== entry.sessionID) return
      request(where, entry.id, entry.question)
    },
    discard(entry) {
      controllers.get(entry.id)?.abort()
      controllers.delete(entry.id)
      setHistory(entry.sessionID, (list) => (list ?? []).filter((item) => item.id !== entry.id))
      if (entries(entry.sessionID).length === 0) api.ui.dialog.clear()
    },
    ask(from) {
      promptForQuestion(() => open(from.sessionID, from.id))
    },
    async fork(entry) {
      const where = target()
      if (!where || entry.status !== "done" || !entry.text || !entry.agent || !entry.model) return
      const { data, error } = await api.client.session.fork({
        sessionID: entry.sessionID,
        directory: where.directory,
        workspace: where.workspace,
        continuation: {
          prompt: entry.question,
          response: entry.text,
          agent: entry.agent,
          model: entry.model,
          ...(entry.finish ? { finish: entry.finish } : {}),
        },
      })
      if (disposed) return
      if (error || !data) {
        api.ui.toast({ variant: "error", message: friendlyErrorMessage(error, "Could not fork the session") })
        return
      }
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: data.id })
      api.ui.toast({ variant: "success", message: "Forked with the side answer — continue from here" })
    },
  }

  function open(sessionID: string, entryID: number) {
    api.ui.dialog.replace(
      () => <BtwDialog sessionID={sessionID} entryID={entryID} actions={actions} />,
      () => {
        if (showing === sessionID) showing = undefined
      },
    )
    showing = sessionID
  }

  const unregister = api.keymap.registerLayer(() => {
    const where = target()
    const count = where ? entries(where.sessionID).length : 0
    return {
      commands: [
        {
          name: "session.aside",
          title: "Ask a side question",
          description: "One-shot answer from the session's context, not added to the conversation",
          namespace: "Session",
          slashName: "btw",
          slashArguments: true,
          run(input) {
            if (disposed) return
            const question = input?.trim()
            if (question) ask(question)
            else if (target()) promptForQuestion()
            else api.ui.toast({ variant: "warning", message: "Open a session to ask a side question" })
          },
        },
        {
          name: "session.aside.history",
          title: "Side question history",
          description: count === 1 ? "1 /btw answer in this session" : `${count} /btw answers in this session`,
          namespace: "Session",
          enabled: count > 0,
          hidden: count === 0,
          run() {
            const current = target()
            const last = current ? entries(current.sessionID).at(-1) : undefined
            if (disposed || !current || !last) return
            open(current.sessionID, last.id)
          },
        },
      ],
    }
  })

  api.lifecycle.onDispose(() => {
    disposed = true
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    unregister()
  })
}

/**
 * `status` is set only for a status the contract does not declare. A bare 404
 * or 405 there is the route itself missing (the server routes an unknown POST
 * under `/session/:id/` to one of the two): the TUI is newer than the server
 * it is attached to — typically a background service started before an update.
 */
function failureMessage(error: unknown, status?: number) {
  if (status === 404 || status === 405) {
    return "The nikcli server this TUI is attached to predates /btw. Restart it — for the background service, run `nikcli service restart`."
  }
  const message = friendlyErrorMessage(error, "Could not answer the side question")
  return status ? `${message} (HTTP ${status})` : message
}

export default {
  id: "internal:btw",
  tui,
} satisfies TuiPluginModule & { id: string }
