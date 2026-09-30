/**
 * The city as a model: which shops stand where, who sits at which desk, and
 * what is still moving. It is fed ADE's picture (shops and sessions, the way
 * `world.js` keeps it) and stepped in time; the view only draws what it says.
 *
 * Animation lives here as numbers, so the tests can say "a shop that opens is
 * up after 0.8 s" and "a shop that closes goes down, and is gone when it is down".
 */

import type { Agent, Shop } from "../protocol"
import {
  COMPUTER_HEIGHT,
  DESKS_PER_SHOP,
  deskLocal,
  placeShops,
  placementOf,
  shopBoxes,
  standLocal,
  toWorld,
  worldRadius,
  type Box,
  type Placement,
  type Vec2,
} from "./layout"
import type { Pickable } from "./interaction"
import { lookOf, type StateLook } from "./states"

/** A shop takes this long to come up from the pavement, or to go back into it. */
export const RISE_SECONDS = 0.8
/** A person takes this long to appear at their desk or to leave it. */
export const PRESENCE_SECONDS = 0.4
/** A change of state is blended in over this long. */
export const POSE_BLEND_SECONDS = 0.25

/** ADE's picture as `world.js` holds it. */
export interface Picture {
  shops: ReadonlyMap<string, Shop>
  agents: ReadonlyMap<string, Agent>
}

export type Seat = { kind: "desk"; desk: number } | { kind: "stand"; index: number }

export interface ShopEntity {
  id: string
  shop: Shop
  slot: number
  placement: Placement
  /** 0 = under the pavement, 1 = standing; moves linearly, the view eases it. */
  lift: number
  /** The project is closed: the shop is going down and will be gone at 0. */
  closing: boolean
}

export interface AgentEntity {
  paneId: string
  agent: Agent
  shopId: string
  seat: Seat
  /** 0..1: appearing or leaving. */
  presence: number
  leaving: boolean
  look: StateLook
  /** The look before the last change, blended out as `blend` goes 0 → 1. */
  previous: StateLook
  blend: number
}

/** The ease of a shop's rise; going down is the same curve backwards. */
export const liftEase = (lift: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, lift)), 3)

const move = (value: number, target: number, step: number) =>
  target > value ? Math.min(target, value + step) : Math.max(target, value - step)

export function createTown() {
  const shops = new Map<string, ShopEntity>()
  const agents = new Map<string, AgentEntity>()
  const slots = new Map<string, number>()

  const shopEntities = () => [...shops.values()]

  /** Lowest free desk of a shop, else the lowest free standing place. */
  const seatFor = (shopId: string, self?: string): Seat => {
    const desks = new Set<number>()
    const stands = new Set<number>()
    for (const a of agents.values()) {
      if (a.shopId !== shopId || a.paneId === self) continue
      if (a.seat.kind === "desk") desks.add(a.seat.desk)
      else stands.add(a.seat.index)
    }
    for (let i = 0; i < DESKS_PER_SHOP; i++) if (!desks.has(i)) return { kind: "desk", desk: i }
    let index = 0
    while (stands.has(index)) index++
    return { kind: "stand", index }
  }

  /** How many desks a shop draws: enough for who sits there, and never an empty room. */
  const deskCount = (shopId: string): number => {
    let top = -1
    for (const a of agents.values()) if (a.shopId === shopId && a.seat.kind === "desk") top = Math.max(top, a.seat.desk)
    return Math.min(DESKS_PER_SHOP, Math.max(2, top + 1))
  }

  const spot = (a: AgentEntity): { at: Vec2; yaw: number; onDesk: boolean } | undefined => {
    const s = shops.get(a.shopId)
    if (!s) return undefined
    if (a.seat.kind === "desk") {
      const at = toWorld(s.placement, deskLocal(a.seat.desk).chair)
      return { at, yaw: s.placement.yaw + Math.PI, onDesk: true }
    }
    // Behind the counter, facing the hologram.
    return { at: toWorld(s.placement, standLocal(a.seat.index)), yaw: s.placement.yaw, onDesk: false }
  }

  return {
    /** Takes ADE's picture: shops and sessions that are new appear, the ones that are gone start to leave. */
    sync(picture: Picture) {
      const placed = placeShops([...picture.shops.values()], slots)
      for (const shop of picture.shops.values()) {
        const slot = placed.get(shop.id) as number
        slots.set(shop.id, slot)
        const known = shops.get(shop.id)
        if (known) {
          known.shop = shop
          known.closing = false
          if (known.slot !== slot) {
            known.slot = slot
            known.placement = placementOf(slot)
          }
        } else {
          shops.set(shop.id, { id: shop.id, shop, slot, placement: placementOf(slot), lift: 0, closing: false })
        }
      }
      for (const known of shops.values()) if (!picture.shops.has(known.id)) known.closing = true

      for (const agent of picture.agents.values()) {
        if (!shops.has(agent.shop)) continue
        const known = agents.get(agent.paneId)
        if (known) {
          const next = lookOf(agent.state)
          if (known.agent.state !== agent.state) {
            known.previous = known.look
            known.look = next
            known.blend = 0
          }
          known.agent = agent
          known.leaving = false
          if (known.shopId !== agent.shop) {
            known.shopId = agent.shop
            known.seat = seatFor(agent.shop, agent.paneId)
          }
        } else {
          const look = lookOf(agent.state)
          agents.set(agent.paneId, {
            paneId: agent.paneId,
            agent,
            shopId: agent.shop,
            seat: seatFor(agent.shop),
            presence: 0,
            leaving: false,
            look,
            previous: look,
            blend: 1,
          })
        }
      }
      for (const known of agents.values()) {
        if (picture.agents.has(known.paneId)) continue
        // In a shop that is going down the people go down with it; elsewhere they leave on their own.
        if (!shops.get(known.shopId)?.closing) known.leaving = true
      }
    },

    /** Advances every animation by `dt` seconds and drops what has finished leaving. */
    tick(dt: number) {
      for (const s of [...shops.values()]) {
        s.lift = move(s.lift, s.closing ? 0 : 1, dt / RISE_SECONDS)
        if (s.closing && s.lift <= 0) {
          shops.delete(s.id)
          slots.delete(s.id)
          for (const a of [...agents.values()]) if (a.shopId === s.id) agents.delete(a.paneId)
        }
      }
      for (const a of [...agents.values()]) {
        a.presence = move(a.presence, a.leaving ? 0 : 1, dt / PRESENCE_SECONDS)
        if (a.leaving && a.presence <= 0) agents.delete(a.paneId)
        else a.blend = Math.min(1, a.blend + dt / POSE_BLEND_SECONDS)
      }
    },

    /** Whether anything is still moving: when not, the city can rest and draw nothing. */
    get animating(): boolean {
      for (const s of shops.values()) if (s.closing || s.lift < 1) return true
      for (const a of agents.values()) if (a.leaving || a.presence < 1 || a.blend < 1) return true
      return false
    },

    shops: shopEntities,
    agents: () => [...agents.values()],
    agentsOf: (shopId: string) => [...agents.values()].filter((a) => a.shopId === shopId),
    deskCount,
    spot,

    /** How far the character may walk. */
    radius: () => worldRadius([...slots.values()]),

    /** The boxes on the ground: walls and desks of every shop that is standing, for the character. */
    boxes(): Box[] {
      const out: Box[] = []
      for (const s of shops.values()) if (s.lift >= 0.3) out.push(...shopBoxes(s.placement, deskCount(s.id)))
      return out
    },

    /** The walls a click cannot see through (no desks: a desk is lower than the ray that matters). */
    walls(): Box[] {
      const out: Box[] = []
      for (const s of shops.values()) if (s.lift >= 0.3) out.push(...shopBoxes(s.placement, 0))
      return out
    },

    /** The computers (or, for someone standing, the person) that a click or `E` can open. */
    pickables(): Pickable[] {
      const out: Pickable[] = []
      for (const a of agents.values()) {
        const s = shops.get(a.shopId)
        if (!s || s.closing || s.lift < 0.95 || a.leaving || a.presence < 0.5) continue
        if (a.seat.kind === "desk") {
          const c = toWorld(s.placement, deskLocal(a.seat.desk).computer)
          out.push({ paneId: a.paneId, x: c.x, y: COMPUTER_HEIGHT, z: c.z, radius: 0.6 })
        } else {
          const p = toWorld(s.placement, standLocal(a.seat.index))
          out.push({ paneId: a.paneId, x: p.x, y: 1.2, z: p.z, radius: 0.55 })
        }
      }
      return out
    },
  }
}

export type Town = ReturnType<typeof createTown>
