/**
 * The bench's fixed scene and its eight shots: the same six shops and eighteen people in the same states, the
 * same clock, the same eight cameras, every time, so that two pictures of a shot differ only in what the renderer
 * did (`?shot=N`, `scripts/nikverse-shots.ts`). Nothing here reads the world's picture, the clock or a random
 * number: the scene is made from the test snapshot below.
 */

import type { Agent, Shop } from "../protocol"
import { COMPUTER_HEIGHT, deskLocal, placementOf, toWorld, type Vec2 } from "./layout"
import type { Picture } from "./town"

/** The world clock of every shot, seconds: the hologram and the people are posed at this time. */
export const SHOT_CLOCK = 12
/** The shots are drawn at this size, whatever the page's, with a pixel ratio of 1. */
export const SHOT_WIDTH = 1600
export const SHOT_HEIGHT = 900
export const SHOT_COUNT = 8

const SHOP_SLOTS = [0, 2, 4, 6, 8, 10]
const SHOP_NAMES = ["nikcli", "ade", "voice", "web", "api", "docs"]
/** Three people in each shop, by shop: every state that puts somebody at a desk shows up. */
const STATES: ReadonlyArray<ReadonlyArray<Agent["state"]>> = [
  ["work", "perm", "ask"],
  ["work", "work", "idle"],
  ["err", "work", "limit"],
  ["work", "perm", "work"],
  ["ask", "idle", "work"],
  ["limit", "work", "perm"],
]

export const SHOT_SHOPS = SHOP_SLOTS.length
export const SHOT_PEOPLE = STATES.reduce((n, s) => n + s.length, 0)

/** The scene: `count` shops (the first ones), each with its people. */
export function shotPicture(count = SHOT_SHOPS): Picture {
  const shops = new Map<string, Shop>()
  const agents = new Map<string, Agent>()
  let n = 0
  for (let i = 0; i < Math.min(count, SHOT_SHOPS); i++) {
    const id = `shot-shop-${i}`
    shops.set(id, { id, name: SHOP_NAMES[i], slot: SHOP_SLOTS[i] })
    for (const state of STATES[i]) {
      const paneId = `shot-pane-${n}`
      agents.set(paneId, { paneId, title: `agent ${n}`, kind: "claude-code", shop: id, state, since: 1, look: { body: n, palette: n } })
      n++
    }
  }
  return { shops, agents }
}

export interface Shot {
  n: number
  name: string
  eye: [number, number, number]
  look: [number, number, number]
  fov: number
  /** What the shot is for, in a line, for the page it is judged on. */
  about: string
  /** The last shop is put up half a rise before the picture is taken. */
  rising?: boolean
  /**
   * The mean luminance the picture must have, 0..1 in sRGB: a band, so that a renderer that goes dark or blows out
   * is caught and an effect that changes the mood a little is not.
   */
  luminance: [number, number]
}

const at = (v: Vec2, y: number): [number, number, number] => [v.x, y, v.z]
const shop = (index: number) => placementOf(SHOP_SLOTS[index])
/** A point of a shop's own frame, in the world. */
const inShop = (index: number, x: number, y: number, z: number): [number, number, number] => at(toWorld(shop(index), { x, z }), y)
/** A point on the ring's radius `r` at `degrees` clockwise from the direction the character first looks at. */
const ring = (degrees: number, r: number, y: number): [number, number, number] => {
  const a = (degrees * Math.PI) / 180
  return [Math.sin(a) * r, y, -Math.cos(a) * r]
}

const desk0 = deskLocal(0)
const desk1 = deskLocal(1)

// The luminance bands are from the first bench (2026-09-29, Bassa and Media on the same machine): 0.6 times the darker
// level's mean to 1.6 times the lighter's. Wide enough for an effect that changes the mood, narrow enough to catch a
// picture that goes dark or blows out.

export const SHOTS: ReadonlyArray<Shot> = [
  // 1. The square from the entrance of a shop, at a person's height: the hologram, and the shops across.
  { n: 1, name: "plaza", eye: [0, 1.7, 14], look: [0, 2.3, 0], fov: 58,
    about: "La piazza dall'ingresso, ad altezza d'uomo: l'ologramma e il selciato.", luminance: [0.08, 0.28] },
  // 2. The ring from the air, three quarters.
  { n: 2, name: "aerial", eye: [-30, 26, 34], look: [0, 0, 0], fov: 58,
    about: "La vista aerea 3/4 dell'anello intero: il diorama.", luminance: [0.09, 0.27] },
  // 3. A shop's front with its sign, close.
  { n: 3, name: "facade", eye: [2.5, 1.6, -9], look: [0, 2.6, -16.5], fov: 58,
    about: "Una facciata con l'insegna, da vicino: materiali e testo.", luminance: [0.08, 0.21] },
  // 4. Inside a shop, over the shoulder of somebody typing, at their monitor.
  {
    n: 4,
    name: "desk",
    eye: inShop(0, desk0.chair.x + 1.4, 1.7, desk0.chair.z + 1.2),
    look: inShop(0, desk0.computer.x, COMPUTER_HEIGHT, desk0.computer.z),
    fov: 58,
    about: "Dentro un negozio, sopra la spalla di chi scrive: il personaggio.",
    luminance: [0.15, 0.4],
  },
  // 5. Somebody who asks for permission, from the far side of the ring, 38 m away: the mark over them must still read.
  {
    n: 5,
    name: "permission",
    eye: [-6.5, 2.2, -19.5],
    look: inShop(3, desk1.chair.x, 1.6, desk1.chair.z),
    fov: 22,
    about: "Un agente che aspetta l'utente, visto da 38 m: la leggibilità.",
    luminance: [0.11, 0.37],
  },
  // 6. The hologram, close.
  { n: 6, name: "hologram", eye: [0, 2.4, 7], look: [0, 2.6, 0], fov: 58,
    about: "L'ologramma da vicino.", luminance: [0.17, 0.48] },
  // 7. The street between two shops, out to the edge of the world.
  { n: 7, name: "street", eye: ring(90, 8, 1.7), look: ring(90, 70, 2.4), fov: 72,
    about: "La strada tra due negozi verso l'esterno: skyline e periferia.", luminance: [0.08, 0.22] },
  // 8. A shop coming up from the pavement, half way.
  { n: 8, name: "rise", eye: [-7, 2, 2], look: [-16.45, 1, -9.5], fov: 58,
    about: "Un negozio a metà della salita: la transizione.", rising: true, luminance: [0.07, 0.23] },
]

export function shotOf(n: number): Shot | undefined {
  return Number.isInteger(n) ? SHOTS.find((s) => s.n === n) : undefined
}
