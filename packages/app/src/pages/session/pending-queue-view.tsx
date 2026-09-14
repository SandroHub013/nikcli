import { createResource, createEffect, For, onCleanup, Show } from "solid-js"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { Icon } from "@nikcli-ai/ui/icon"
import { showToast } from "@nikcli-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { pendingSummary, pendingText, queuedEntries, type PendingEntry } from "./pending-queue"

/**
 * What is waiting to be sent, above the composer.
 *
 * Each row offers the two things you can want from a message you already sent:
 * hand it to the agent *now*, in the middle of the running turn, or take it back
 * into the composer. The second is the one you reach for first when you queued
 * the wrong thing, and it is why the row returns its text rather than just an
 * acknowledgement.
 *
 * Sending while the agent works neither fails nor interrupts — the server stores
 * the prompt and delivers it when the turn ends. Nothing said so, so the message
 * left the composer and reappeared minutes later, which is indistinguishable
 * from having lost it.
 *
 * Each row also offers what the API has always supported and the UI never did:
 * hand the message to the agent *now*, in the middle of the running turn, rather
 * than after it. That is what you want the moment you see it heading the wrong
 * way.
 */
export function PendingQueue(props: {
  sessionID: string | undefined
  busy: boolean
  /** Puts a taken-back message back where the user can edit it. */
  onTakeBack: (text: string) => void
  /**
   * Bumped by the composer on every send. The queue is read from the server, so
   * without a nudge the message you just queued would not appear until the next
   * poll — up to four seconds of exactly the doubt this strip exists to remove.
   */
  submitted: number
}) {
  const sdk = useSDK()
  const language = useLanguage()

  const [entries, { refetch, mutate }] = createResource(
    // Keyed on `busy` as well as the id: the queue only fills during a turn, and
    // re-reading it when the turn ends is how the rows clear.
    () =>
      props.sessionID ? { sessionID: props.sessionID, busy: props.busy, submitted: props.submitted } : undefined,
    async ({ sessionID }) => {
      const result = await sdk.client.session.pending({ sessionID })
      return ((result as { data?: PendingEntry[] }).data ?? []) as PendingEntry[]
    },
    { initialValue: [] },
  )

  // Polling is the backstop, not the mechanism: a send refetches immediately
  // through `submitted` above. This catches the rest — another client, or a
  // message promoted out of the queue by the running turn.
  createEffect(() => {
    if (!props.busy || !props.sessionID) return
    const timer = setInterval(() => void refetch(), 4000)
    // `onCleanup`, not a returned function: Solid stores an effect's return value
    // as the computation's next input and never calls it, so returning the
    // clearInterval left one live poller per run — permanently, past unmount.
    onCleanup(() => clearInterval(timer))
  })

  // Never read without checking `error` first. The SDK is built with
  // `throwOnError`, so a failed request rejects the resource and reading it in
  // the render rethrows — the nearest boundary is the one at the root, which
  // would replace the whole app with the error page because a queue poll failed.
  const waiting = () => (entries.error ? [] : queuedEntries(entries() ?? []))

  const steer = async (entry: PendingEntry) => {
    if (!props.sessionID) return
    // Optimistic: the row is about to be delivered, and leaving it listed as
    // "waiting" until the next poll would invite a second click.
    mutate((current) => (current ?? []).filter((item) => item.id !== entry.id))
    await sdk.client.session
      .pendingSteer({ sessionID: props.sessionID, pendingID: entry.id })
      .then(() => showToast({ variant: "success", icon: "circle-check", title: language.t("session.queue.steered") }))
      .catch((error: unknown) => {
        void refetch()
        showToast({
          variant: "error",
          title: language.t("session.queue.steerFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const takeBack = async (entry: PendingEntry) => {
    if (!props.sessionID) return
    mutate((current) => (current ?? []).filter((item) => item.id !== entry.id))
    await sdk.client.session
      .pendingDrop({ sessionID: props.sessionID, pendingID: entry.id })
      .then(() => props.onTakeBack(pendingText(entry)))
      .catch((error: unknown) => {
        // It may already have been delivered — the turn ends without warning.
        void refetch()
        showToast({
          variant: "error",
          title: language.t("session.queue.takeBackFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * Take the whole queue back at once.
   *
   * Row by row is fine for two; a queue that built up while a long turn ran is
   * where you want one action. The texts are joined in the order they were sent,
   * so what comes back reads as what was written.
   */
  const takeBackAll = async () => {
    const all = waiting()
    if (!props.sessionID || all.length === 0) return
    mutate([])
    const dropped: string[] = []
    for (const entry of all) {
      const ok = await sdk.client.session
        .pendingDrop({ sessionID: props.sessionID, pendingID: entry.id })
        .then(() => true)
        .catch(() => false)
      // A message already delivered cannot come back; the rest still can, so
      // this keeps going rather than abandoning the ones behind it.
      if (ok) dropped.push(pendingText(entry))
    }
    const text = dropped.filter(Boolean).join("\n\n")
    if (text) props.onTakeBack(text)
    if (dropped.length < all.length) {
      showToast({ variant: "error", title: language.t("session.queue.takeBackPartial") })
    }
    // Always, not only on partial failure: a row queued from another client
    // between the render and the last drop would otherwise stay invisible until
    // the next poll, and `mutate([])` has just claimed the queue is empty.
    void refetch()
  }

  return (
    <Show when={waiting().length > 0}>
      <div data-component="pending-queue" aria-live="polite">
        <div data-slot="pending-queue-header">
          <span data-slot="pending-queue-title">
            {waiting().length === 1
            ? language.t("session.queue.title.one")
            : language.t("session.queue.title", { count: String(waiting().length) })}
          </span>
          <Show when={waiting().length > 1}>
            <button type="button" data-slot="pending-queue-clear" onClick={() => void takeBackAll()}>
              {language.t("session.queue.takeBackAll")}
            </button>
          </Show>
        </div>
        <For each={waiting()}>
          {(entry) => (
            <div data-slot="pending-queue-row">
              <Icon name="checklist" size="small" class="shrink-0" />
              <span data-slot="pending-queue-text">{pendingSummary(entry)}</span>
              <IconButton
                icon="arrow-up"
                variant="ghost"
                onClick={() => void steer(entry)}
                aria-label={language.t("session.queue.steer")}
                title={language.t("session.queue.steer")}
              />
              <IconButton
                icon="close"
                variant="ghost"
                onClick={() => void takeBack(entry)}
                aria-label={language.t("session.queue.takeBack")}
                title={language.t("session.queue.takeBack")}
              />
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
