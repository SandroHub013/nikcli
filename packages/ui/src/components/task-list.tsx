import { createMemo, For, Show, type ComponentProps } from "solid-js"
import { Icon } from "./icon"

/**
 * The agent's own task list.
 *
 * The server has emitted `todo.updated` and the client has kept the list in sync
 * all along; nothing ever rendered it, so the plan the agent was working to was
 * invisible while it worked. Statuses come from the server as free-form strings
 * (`pending`, `in_progress`, `completed`, `cancelled`), so unknown values degrade
 * to pending rather than disappearing.
 */

export type TaskItem = {
  id: string
  content: string
  status: string
  priority?: string
}

export type TaskState = "pending" | "active" | "done" | "cancelled"

export function taskState(status: string): TaskState {
  if (status === "completed") return "done"
  if (status === "cancelled") return "cancelled"
  if (status === "in_progress") return "active"
  return "pending"
}

/**
 * Completed work over work that still counts.
 *
 * Cancelled tasks are removed from the denominator rather than added to the
 * numerator: counting them as done made the ratio disagree with the list, which
 * showed a tick only for genuinely completed tasks. Abandoned work is not
 * progress, and it is not outstanding either.
 */
export function taskProgress(items: readonly TaskItem[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const item of items) {
    const state = taskState(item.status)
    if (state === "cancelled") continue
    total += 1
    if (state === "done") done += 1
  }
  return { done, total }
}

/** The task the agent is on, else the next one it will pick up. */
export function currentTask(items: readonly TaskItem[]): TaskItem | undefined {
  return items.find((item) => taskState(item.status) === "active") ?? items.find((item) => taskState(item.status) === "pending")
}

const ICON: Record<TaskState, Parameters<typeof Icon>[0]["name"]> = {
  pending: "dot-grid",
  active: "dash",
  done: "circle-check",
  cancelled: "circle-ban-sign",
}

export function TaskList(
  props: {
    items: readonly TaskItem[]
    /** Collapsed shows only the count and the task in flight. */
    collapsed?: boolean
    onToggle?: () => void
    label: string
    class?: string
    classList?: ComponentProps<"div">["classList"]
  },
) {
  const progress = createMemo(() => taskProgress(props.items))
  const current = createMemo(() => currentTask(props.items))

  return (
    <Show when={props.items.length > 0}>
      <div
        data-component="task-list"
        data-collapsed={props.collapsed ? "" : undefined}
        classList={{ ...(props.classList ?? {}), [props.class ?? ""]: !!props.class }}
      >
        <button
          type="button"
          data-slot="task-list-head"
          aria-expanded={!props.collapsed}
          onClick={() => props.onToggle?.()}
        >
          <Icon name={props.collapsed ? "chevron-right" : "chevron-down"} size="small" />
          <span data-slot="task-list-label">{props.label}</span>
          <span data-slot="task-list-count">
            {progress().done}/{progress().total}
          </span>
          <Show when={props.collapsed && current()}>
            {(item) => (
              <span data-slot="task-list-current" title={item().content}>
                {item().content}
              </span>
            )}
          </Show>
        </button>

        <Show when={!props.collapsed}>
          <ol data-slot="task-list-items">
            <For each={props.items}>
              {(item) => (
                <li data-slot="task-list-item" data-state={taskState(item.status)}>
                  <Icon name={ICON[taskState(item.status)]} size="small" />
                  <span>{item.content}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
    </Show>
  )
}
