/**
 * The world's picture of ADE, and what changed in it.
 *
 * `worldSnapshot` is a pure function of the workbench: the projects and
 * sessions that are really there become shops and agents, and each agent's
 * state is the one the pane's own header shows (`resolvePaneState`), never a
 * second opinion. `diffSnapshots` turns two pictures into the events the world
 * applies, so after the first snapshot only what changed crosses the channel.
 *
 * Only titles, states, kinds, project names and counters go in. A transcript,
 * a path or a folder never does: the shop's id is a hash of the folder, not the
 * folder.
 */

import { resolvePaneState, type PaneState, type PaneStatus } from "../grid/pane-state"
import { pathEquals } from "../host/path"
import type { SessionQuota } from "../session/quota"
import type { ProjectRef } from "../surface/pane-project"
import { isPanelPane, type Pane } from "../surface/state"
import type { Agent, Shop, Snapshot, WorldEvent } from "./protocol"

/** How many bodies and palettes the world has to draw a character from. */
export const BODIES = 6
export const PALETTES = 8

/** A small stable hash: the same text gives the same number in every run and on every machine. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** How an agent looks, from its title alone: renaming it changes it, restarting it does not. */
export function lookOf(title: string): Agent["look"] {
  const hash = hashText(title)
  return { body: hash % BODIES, palette: Math.floor(hash / BODIES) % PALETTES }
}

/** The stable id of a project's shop: its folder when it has one (case and slashes ignored), else its name. */
export function shopId(project: ProjectRef | { name: string; root?: string }): string {
  const key = project.root ? `r:${project.root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}` : `n:${project.name}`
  return `s${hashText(key).toString(36)}`
}

/**
 * The places around the square, given out in the order projects appear and
 * kept: a shop keeps its place while it is open, a closed one frees it, and a
 * new one takes the lowest free place without moving the others.
 */
export function createSlotBook() {
  const held = new Map<string, number>()
  return {
    /** The slot of each of `ids`, in order; ids no longer present give theirs back. */
    assign(ids: readonly string[]): Map<string, number> {
      const present = new Set(ids)
      for (const id of [...held.keys()]) if (!present.has(id)) held.delete(id)
      const taken = new Set(held.values())
      for (const id of ids) {
        if (held.has(id)) continue
        let slot = 0
        while (taken.has(slot)) slot++
        held.set(id, slot)
        taken.add(slot)
      }
      return new Map(held)
    },
  }
}
export type SlotBook = ReturnType<typeof createSlotBook>

/** What ADE knows about a pane that the pane itself does not carry: whether its process is there, what it asks. */
export interface PaneFacts {
  /** The activity the header shows: the agent's report, or `suspended`. */
  activity?: string
  /** No process behind the pane any more. */
  exited?: boolean
  /** The agent has asked the user something (a permission prompt is standing). */
  hasActions?: boolean
  quota?: SessionQuota
}

type WorldPane = Pick<
  Pane,
  "id" | "title" | "status" | "mode" | "agent" | "model" | "workspaceId" | "projectRoot" | "activity" | "suspended"
> &
  Partial<Pick<Pane, "browserUrl" | "filePath" | "videoPath" | "modelPath" | "appUrl" | "plugin">>

/** A pane the world draws: a session with an agent, not a file, a browser or another panel. */
export function isWorldSession(pane: WorldPane): boolean {
  return !isPanelPane({ ...pane, mode: pane.mode ?? "" }) && Boolean(pane.agent ?? pane.model)
}

export interface SnapshotInput {
  panes: readonly WorldPane[]
  /** The project open in ADE, which always has its shop. */
  open?: ProjectRef
  facts: (pane: WorldPane) => PaneFacts
  /** Decisions waiting for the user. */
  decisions: number
  now: number
  /** The last picture sent: an agent that has not changed state keeps its `since`. */
  previous?: Snapshot
  slots?: SlotBook
}

export function worldSnapshot(input: SnapshotInput): Snapshot {
  const sessions = input.panes.filter(isWorldSession)

  // One shop per project that is open in ADE or has a session in it, in the order they appear.
  const projects: { name: string; root?: string }[] = []
  const shopOf = (pane: { workspaceId?: string; projectRoot?: string }): { name: string; root?: string } => {
    const found = projects.find((project) =>
      pane.projectRoot && project.root ? pathEquals(pane.projectRoot, project.root) : pane.workspaceId === project.name,
    )
    if (found) return found
    const created = {
      name: pane.workspaceId || (pane.projectRoot ? pane.projectRoot.split(/[\\/]/).filter(Boolean).pop()! : "—"),
      ...(pane.projectRoot ? { root: pane.projectRoot } : {}),
    }
    projects.push(created)
    return created
  }
  if (input.open) projects.push({ name: input.open.name, root: input.open.root })
  const owners = sessions.map((pane) => ({ pane, project: shopOf(pane) }))

  const ids = projects.map((project) => shopId(project))
  const slots = input.slots?.assign(ids)
  const shops: Shop[] = projects.map((project, index) => ({
    id: ids[index]!,
    name: project.name,
    ...(slots ? { slot: slots.get(ids[index]!)! } : {}),
  }))

  const before = new Map((input.previous?.agents ?? []).map((agent) => [agent.paneId, agent]))
  const agents: Agent[] = owners.map(({ pane, project }) => {
    const state = paneState(pane, input.facts(pane))
    const earlier = before.get(pane.id)
    return {
      paneId: pane.id,
      title: pane.title,
      kind: pane.agent ?? pane.model,
      shop: shopId(project),
      state,
      since: earlier && earlier.state === state ? earlier.since : input.now,
      look: lookOf(pane.title),
    }
  })

  return { at: input.now, shops, agents, waiting: { decisions: input.decisions } }
}

/** The state the pane's header shows for it: the same function, fed the same things. */
export function paneState(pane: Pick<WorldPane, "status" | "activity" | "suspended">, facts: PaneFacts): PaneState {
  return resolvePaneState({
    status: pane.status as PaneStatus,
    activity: pane.suspended ? "suspended" : (facts.activity ?? pane.activity),
    ...(facts.exited !== undefined ? { exited: facts.exited } : {}),
    ...(facts.hasActions !== undefined ? { hasActions: facts.hasActions } : {}),
    ...(facts.quota ? { quota: facts.quota } : {}),
  })
}

/** What happened between two pictures, in the order the world should apply it. */
export function diffSnapshots(previous: Snapshot, next: Snapshot): WorldEvent[] {
  const events: WorldEvent[] = []
  const oldShops = new Map(previous.shops.map((shop) => [shop.id, shop]))
  const newShops = new Map(next.shops.map((shop) => [shop.id, shop]))
  const oldAgents = new Map(previous.agents.map((agent) => [agent.paneId, agent]))
  const newAgents = new Map(next.agents.map((agent) => [agent.paneId, agent]))

  // A shop appears before its people and disappears after them.
  for (const shop of next.shops) if (!oldShops.has(shop.id)) events.push({ type: "shop-open", shop })
  for (const agent of next.agents) if (!oldAgents.has(agent.paneId)) events.push({ type: "agent-spawn", agent })
  for (const agent of next.agents) {
    const earlier = oldAgents.get(agent.paneId)
    if (earlier && earlier.state !== agent.state)
      events.push({ type: "state", paneId: agent.paneId, state: agent.state, at: next.at })
  }
  for (const agent of previous.agents) if (!newAgents.has(agent.paneId)) events.push({ type: "agent-close", agent })
  for (const shop of previous.shops) if (!newShops.has(shop.id)) events.push({ type: "shop-close", shop })
  if (previous.waiting.decisions !== next.waiting.decisions)
    events.push({ type: "waiting", decisions: next.waiting.decisions })
  return events
}

/**
 * Whether something the events cannot say has changed (a title, a sign, a
 * place, a look): then the whole picture is sent again instead of the events,
 * so the world never shows a name that ADE no longer uses.
 */
export function needsResync(previous: Snapshot, next: Snapshot): boolean {
  const oldShops = new Map(previous.shops.map((shop) => [shop.id, shop]))
  for (const shop of next.shops) {
    const earlier = oldShops.get(shop.id)
    if (earlier && (earlier.name !== shop.name || earlier.slot !== shop.slot)) return true
  }
  const oldAgents = new Map(previous.agents.map((agent) => [agent.paneId, agent]))
  for (const agent of next.agents) {
    const earlier = oldAgents.get(agent.paneId)
    if (
      earlier &&
      (earlier.title !== agent.title ||
        earlier.kind !== agent.kind ||
        earlier.shop !== agent.shop ||
        earlier.look.body !== agent.look.body ||
        earlier.look.palette !== agent.look.palette)
    )
      return true
  }
  return false
}
