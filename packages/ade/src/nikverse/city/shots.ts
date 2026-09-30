/**
 * The bench's fixed scene and its eight shots: the same six shops and eighteen people in the same states, the
 * same clock, the same eight cameras, every time, so that two pictures of a shot differ only in what the renderer
 * did (`?shot=N`, `scripts/nikverse-shots.ts`). Nothing here reads the world's picture, the clock or a random
 * number: the scene is made from the test snapshot below.
 */

import type { Agent, Shop } from "../protocol"
import { COMPUTER_HEIGHT, deskLocal, islandHeight, placementOf, toWorld, type Vec2 } from "./layout"
import type { Picture } from "./town"

/** The world clock of every shot, seconds: the hologram and the people are posed at this time. */
export const SHOT_CLOCK = 12
/** The shots are drawn at this size, whatever the page's, with a pixel ratio of 1. */
export const SHOT_WIDTH = 1600
export const SHOT_HEIGHT = 900
export const SHOT_COUNT = 8

// Six chiringuiti on the north beach, from -65° to 65°.
const SHOP_SLOTS = [0, 1, 2, 3, 4, 5]
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

/** A ground point at `y` above the island's ground there (the beach is higher than the lagoon's floor). */
const at = (v: Vec2, y: number): [number, number, number] => [v.x, y + islandHeight(v), v.z]
const shop = (index: number) => placementOf(SHOP_SLOTS[index])
/** A point of a shop's own frame, in the world, `y` above the ground. */
const inShop = (index: number, x: number, y: number, z: number): [number, number, number] => at(toWorld(shop(index), { x, z }), y)
/** A point on the radius `r` at `degrees` clockwise from the direction the character first looks at, `y` above the ground. */
const ring = (degrees: number, r: number, y: number): [number, number, number] => {
  const a = (degrees * Math.PI) / 180
  return at({ x: Math.sin(a) * r, z: -Math.cos(a) * r }, y)
}

const desk0 = deskLocal(0)
const desk1 = deskLocal(1)

// The luminance bands are from the first bench on the island (Bassa and Media on the same machine): 0.6 times the
// darker level's mean to 1.6 times the lighter's. Wide enough for an effect that changes the mood, narrow enough to
// catch a picture that goes dark or blows out. Until that run they are wide.
const FIRST_RUN: [number, number] = [0.02, 0.6]

export const SHOTS: ReadonlyArray<Shot> = [
  // 1. From the north shore: the hologram against the glow, the mouth and its reefs, the reflection in the lagoon.
  { n: 1, name: "lagoon", eye: ring(0, 17, 1.7), look: [0, 2.3, 0], fov: 58,
    about: "Dalla riva nord: l'ologramma contro il bagliore, la bocca, gli scogli con la schiuma, il riflesso in laguna.", luminance: FIRST_RUN },
  // 2. The island from the air: the mouth in front, the islet, the crescent of chiringuiti, the coloured terraces.
  { n: 2, name: "aerial", eye: [-38, 42, 70], look: [0, 3, -14], fov: 50,
    about: "Il diorama: la bocca, l'isolotto, la mezzaluna dei chiringuiti, le terrazze colorate, l'oceano.", luminance: FIRST_RUN },
  // 3. A chiringuito's front: roof, sign, string lights, loungers.
  { n: 3, name: "chiringuito", eye: inShop(0, 1.5, 1.6, 9), look: inShop(0, 0, 2.4, 0), fov: 58,
    about: "Il fronte di un chiringuito: tetto, insegna, lucine, lettini, materiali.", luminance: FIRST_RUN },
  // 4. Over the shoulder of somebody typing at the bar.
  {
    n: 4,
    name: "desk",
    eye: inShop(0, desk0.chair.x + 1.4, 1.7, desk0.chair.z + 1.2),
    look: inShop(0, desk0.computer.x, COMPUTER_HEIGHT, desk0.computer.z),
    fov: 58,
    about: "Sopra la spalla di chi scrive al portatile: il personaggio.",
    luminance: FIRST_RUN,
  },
  // 5. Somebody who asks for permission, from across the lagoon, about 38 m away: the mark over them must still read.
  {
    n: 5,
    name: "permission",
    eye: ring(70, 19, 2.2),
    look: inShop(3, desk1.chair.x, 1.6, desk1.chair.z),
    fov: 22,
    about: "Un agente che aspetta l'utente, dall'altra riva della laguna: la leggibilità sopra l'acqua.",
    luminance: FIRST_RUN,
  },
  // 6. The hologram, close, with the north chiringuiti and the violet peak behind.
  { n: 6, name: "hologram", eye: [0, 2.4, 7], look: [0, 2.6, 0], fov: 58,
    about: "L'ologramma da vicino, con dietro i chiringuiti nord e la vetta viola.", luminance: FIRST_RUN },
  // 7. Between two chiringuiti up the slope: palms, the plants near and far, the fog. The vegetation's worst case.
  { n: 7, name: "slopes", eye: ring(52, 24, 1.7), look: ring(52, 80, 22), fov: 62,
    about: "Fra due chiringuiti verso il pendio: palme, piante vicine e lontane, nebbia.", luminance: FIRST_RUN },
  // 8. A chiringuito coming up out of the sand, half way: close, with the ring of sand and the puffs around it.
  { n: 8, name: "rise", eye: inShop(5, -2.4, 1.9, 8.5), look: inShop(5, 0, 0.9, 0), fov: 58,
    about: "Un chiringuito a metà della salita dalla sabbia: l'anello di sabbia e gli sbuffi, da 8 m.", rising: true, luminance: FIRST_RUN },
]

export function shotOf(n: number): Shot | undefined {
  return Number.isInteger(n) ? SHOTS.find((s) => s.n === n) : undefined
}
