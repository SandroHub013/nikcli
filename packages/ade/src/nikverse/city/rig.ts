/**
 * N3's people: the four rigged characters, their clips and their three LODs.
 *
 * One `.glb` per character holds the skinned body three times (`*_lod0`, `*_lod1`, `*_lod2`), the parts every
 * LOD wears (hat, helmet, cape), one skeleton and eleven clips shared by all four. The user is the mage and
 * the sessions are the knight, the rogue and the barbarian, by the body ADE's `look` names.
 *
 * The parts that touch the browser (fetching, decoding) are passed in as `Loaded`, so what is decided here,
 * which clip a state plays and which LOD a distance draws, is plain code a test can run on the real files.
 */

import {
  AnimationMixer,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
  type Group,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from "three/webgpu"
import { clone } from "three/addons/utils/SkeletonUtils.js"
import { wearsAccessories } from "./glb"
import type { Pose } from "./states"

/** What a parsed `.glb` gives. */
export interface Loaded {
  scene: Group
  animations: AnimationClip[]
}

export type Role = "idle" | "walk" | "run" | "sit" | "type" | "raise_hand" | "turn" | "error" | "lean" | "wave"

/** The clip each role plays, by the name it has in the files. */
export const CLIP_NAME: Readonly<Record<Role, string>> = {
  idle: "Idle",
  walk: "Walking_A",
  run: "Running_A",
  sit: "sit_idle",
  type: "type",
  raise_hand: "raise_hand",
  turn: "turn",
  error: "error",
  lean: "lean",
  wave: "wave",
}

export const ROLES = Object.keys(CLIP_NAME) as Role[]

/** The clip of a seated session's pose: what the state shows, as the placeholders' poses were named. */
export const ROLE_OF_POSE: Readonly<Record<Pose, Role>> = {
  type: "type",
  "raise-hand": "raise_hand",
  turn: "turn",
  "head-hands": "error",
  "lean-back": "lean",
  sit: "sit",
  away: "sit",
}

/** The bodies a session can have, and the user's own. */
export const AGENT_BODIES = ["agent_knight", "agent_rogue", "agent_barbarian"] as const
export const USER_BODY = "user"
export const BODIES = [USER_BODY, ...AGENT_BODIES] as const
export type Body = (typeof BODIES)[number]

/** The file of a body at a level: its mesh, skeleton and anchors. */
export const glbUrl = (base: string, level: string, body: Body) => `${base}levels/${level}/character_${body}.glb`

/** The clips, one file for every body and every level: the skeleton is the same in all of them. */
export const animationsUrl = (base: string) => `${base}levels/rig_animations.glb`

/** The body ADE's `look` gives a session: stable for a title. */
export const bodyOfLook = (look: { body: number }): Body => AGENT_BODIES[Math.abs(Math.trunc(look.body)) % AGENT_BODIES.length]

/** The distances at which a LOD gives way to the next, in metres. */
export const LOD_UP_TO: readonly [number, number, number] = [7.5, 15, 30]

/** Which LOD to draw at a distance: 0 near, 2 far, and nothing past the last (the impostor takes over). */
export function lodAt(distance: number): 0 | 1 | 2 | undefined {
  if (distance <= LOD_UP_TO[0]) return 0
  if (distance <= LOD_UP_TO[1]) return 1
  if (distance <= LOD_UP_TO[2]) return 2
  return undefined
}

/** One character as loaded: the scene to clone, its clips by role and its three skinned bodies. */
export interface Template {
  body: Body
  scene: Group
  clips: Map<Role, AnimationClip>
  /** How high above the root the clips put the pelvis when seated: the `<body>_anchor_seat` node. */
  seatY: number
}

export type Cast = Map<Body, Template>

/** The three skinned bodies of a character scene, by LOD. */
export function lodsOf(root: Object3D): [SkinnedMesh, SkinnedMesh, SkinnedMesh] {
  const found: Array<SkinnedMesh | undefined> = [undefined, undefined, undefined]
  root.traverse((o) => {
    const match = /_lod([012])$/.exec(o.name)
    if (match && (o as SkinnedMesh).isSkinnedMesh) found[Number(match[1])] = o as SkinnedMesh
  })
  if (found.some((m) => !m)) throw new Error("un personaggio senza i tre LOD")
  return found as [SkinnedMesh, SkinnedMesh, SkinnedMesh]
}

/** Makes a template from a parsed body and the shared clips; one without a clip or a LOD is refused, not drawn half. */
export function templateOf(body: Body, loaded: Loaded, animations: readonly AnimationClip[]): Template {
  const clips = new Map<Role, AnimationClip>()
  for (const role of ROLES) {
    const clip = animations.find((a) => a.name === CLIP_NAME[role])
    if (!clip) throw new Error(`${body}: manca la clip ${CLIP_NAME[role]}`)
    clips.set(role, clip)
  }
  lodsOf(loaded.scene)
  const anchor = loaded.scene.getObjectByName(`${body}_anchor_seat`)
  if (!anchor) throw new Error(`${body}: manca l'ancora della seduta`)
  return { body, scene: loaded.scene, clips, seatY: anchor.position.y }
}

/** The seconds a change of clip takes to blend. */
export const BLEND_SECONDS = 0.25
/** Beyond this, a step of the mixer is not one frame but a gap (a hidden tab): it is not played through. */
const MAX_STEP = 0.25

/** A rigged person: their own copy of the skeleton and a mixer that plays the shared clips. */
export interface Rig {
  root: Group
  lods: [SkinnedMesh, SkinnedMesh, SkinnedMesh]
  /** What every LOD wears, hat, helmet or cape: drawn except at the farthest LOD. */
  accessories: Object3D[]
  mixer: AnimationMixer
  seatY: number
  actions: Map<Role, AnimationAction>
  role?: Role
  lod?: 0 | 1 | 2
  /** The world clock at the last step of the mixer, in seconds. */
  at: number
}

export function createRig(template: Template): Rig {
  const root = clone(template.scene) as Group
  const lods = lodsOf(root)
  // A skinned body moves outside the box it was measured in: never cull it by that box.
  for (const mesh of lods) mesh.frustumCulled = false
  const accessories: Object3D[] = []
  root.traverse((o) => {
    if ((o as Mesh).isMesh && !(o as SkinnedMesh).isSkinnedMesh) accessories.push(o)
  })
  const mixer = new AnimationMixer(root)
  const actions = new Map<Role, AnimationAction>()
  for (const [role, clip] of template.clips) {
    const action = mixer.clipAction(clip)
    action.setLoop(LoopRepeat, Infinity)
    actions.set(role, action)
  }
  return { root, lods, accessories, mixer, seatY: template.seatY, actions, at: 0 }
}

/** Plays a role, blending from the one before. `speed` scales the clip (the walk at the pace the character goes). */
export function play(rig: Rig, role: Role, speed = 1): void {
  const next = rig.actions.get(role)
  if (!next) return
  next.setEffectiveTimeScale(speed)
  if (rig.role === role) return
  const previous = rig.role ? rig.actions.get(rig.role) : undefined
  next.reset().setEffectiveWeight(1).play()
  if (previous) {
    previous.fadeOut(BLEND_SECONDS)
    next.fadeIn(BLEND_SECONDS)
  }
  rig.role = role
}

/** Moves the mixer on to the world clock `t`. Called when the pose is due, so a far person's steps are wider. */
export function advance(rig: Rig, t: number): void {
  const dt = rig.at === 0 ? 0 : Math.min(MAX_STEP, Math.max(0, t - rig.at))
  rig.at = t
  rig.mixer.update(dt)
}

/** Draws one LOD and hides the other two; `undefined` hides them all. */
export function showLod(rig: Rig, lod: 0 | 1 | 2 | undefined): void {
  if (rig.lod === lod && rig.lods.every((m, i) => m.visible === (i === lod))) return
  rig.lod = lod
  rig.lods.forEach((mesh, i) => {
    mesh.visible = i === lod
  })
  const worn = lod !== undefined && wearsAccessories(lod)
  for (const piece of rig.accessories) piece.visible = worn
}

/** Faster than this, in m/s, the character runs (between the walk's 3.2 and the run's 6.4). */
export const RUN_ABOVE = 4.8

/** The role of a character who is walking: standing, walking or running, by the speed in m/s. */
export function roleAtSpeed(speed: number): Role {
  if (speed < 0.05) return "idle"
  return speed > RUN_ABOVE ? "run" : "walk"
}

/** The pace, in m/s, at which each clip plays at its own speed: faster than that plays it faster, slower plays it slower (within limits). */
export const WALK_PACE = 2.1
export const RUN_PACE = 5.3

export function paceOf(role: Role, speed: number): number {
  if (role === "walk") return Math.min(1.7, Math.max(0.6, speed / WALK_PACE))
  if (role === "run") return Math.min(1.5, Math.max(0.7, speed / RUN_PACE))
  return 1
}
