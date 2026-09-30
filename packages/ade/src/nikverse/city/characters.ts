/**
 * The placeholder people: clean geometric figures made of boxes and a sphere,
 * standing until N3's models replace them through the asset manifest.
 *
 * A person is a `Group` with named joints so the pose code can turn them. The
 * feet are at y = 0 and it faces local +z; a seated person is the same figure
 * lowered onto a chair with the legs turned forward.
 */

import {
  BackSide,
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  MeshBasicMaterial,
} from "three/webgpu"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { jointsFor, mixJoints, walkSwing, type Joints } from "./pose"
import { advance, createRig, lodAt, paceOf, play, roleAtSpeed, ROLE_OF_POSE, showLod, type Rig, type Template } from "./rig"
import type { StateLook } from "./states"
import { hairColor, personColor } from "./states"
import { CHAIR_SEAT_TOP } from "./layout"

const box = new BoxGeometry(1, 1, 1)
const sphere = new SphereGeometry(0.5, 20, 14)

const materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>()
/** How tall a seated far figure is, of a standing one's height. */
const IMPOSTOR_SEATED = 0.74

/** One shared material per colour: many people, few materials. */
export function paint(hex: number, options: { emissive?: boolean; rough?: number } = {}) {
  const key = `${hex}:${options.emissive ? "e" : "s"}:${options.rough ?? 0.7}`
  let m = materials.get(key)
  if (!m) {
    m = options.emissive
      ? new MeshBasicMaterial({ color: new Color(hex) })
      : new MeshStandardMaterial({ color: new Color(hex), roughness: options.rough ?? 0.7, metalness: 0.05 })
    materials.set(key, m)
  }
  return m
}

const part = (geometry: BoxGeometry | SphereGeometry, material: MeshStandardMaterial | MeshBasicMaterial, sx: number, sy: number, sz: number) => {
  const mesh = new Mesh(geometry, material)
  mesh.scale.set(sx, sy, sz)
  return mesh
}

export interface Person {
  group: Group
  body: Group
  torso: Group
  head: Group
  armL: Group
  armR: Group
  legL: Group
  legR: Group
  /** The mark over the head, when the session needs the user. */
  signal: Group
  attention: Mesh
  question: Mesh
  /** A soft dark disc on the floor: the only shadow there is (no dynamic shadows). */
  blob: Mesh
  /** The whole figure as a capsule and a head, drawn instead of the figure when it is far. */
  impostor: Group
  /** The pose was last worked out at this time (seconds), for the far people that update ten times a second. */
  posedAt: number
  /** N3's rigged character, when there is one: the joints above are then unused and the clips do the posing. */
  rig?: Rig
}

const blobGeometry = new CircleGeometry(0.5, 20)
/**
 * The far figure: a capsule for the body and a ball for the head, as tall as a person (1.75 m), one mesh of the
 * shirt's colour. From 30 m the head reads by its shape; a colour of its own would be a second draw call a person.
 */
const impostorShape = (() => {
  const body = new CapsuleGeometry(0.24, 0.92, 3, 10).translate(0, 0.7, 0)
  const head = new SphereGeometry(0.19, 10, 8).translate(0, 1.56, 0)
  return mergeGeometries([body, head])!
})()
const markAttention = new OctahedronGeometry(0.16)
const markQuestion = new TorusGeometry(0.13, 0.045, 8, 20)

/**
 * The mark's own material: drawn over everything (a roof, a post, the fog), after the scene, because it is the one
 * thing about a far session the user has to see. Its outline is the same shape a quarter larger, dark, behind it.
 */
function markMaterial(hex: number, outline = false): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(hex), depthTest: false, depthWrite: false, fog: false, side: outline ? BackSide : undefined })
}
const MARK_ORDER = 1000

function mark(geometry: OctahedronGeometry | TorusGeometry, hex: number): Mesh {
  const mesh = new Mesh(geometry, markMaterial(hex))
  mesh.renderOrder = MARK_ORDER + 1
  const outline = new Mesh(geometry, markMaterial(0x14100c, true))
  outline.scale.setScalar(1.3)
  outline.renderOrder = MARK_ORDER
  mesh.add(outline)
  return mesh
}
const blobMaterial = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })

/** Draws the figure or its impostor: near, the figure with its shadow; far, the one box. */
export function showDetail(person: Person, detail: "full" | "slow" | "impostor", distance = 0): void {
  const far = detail === "impostor"
  person.body.visible = !far
  // The mark over the head is not part of the figure: it stays at any distance (`setSignal`).
  person.impostor.visible = far
  // The soft shadow on the floor goes with the figure: from 30 m it is a few pixels, and a draw call a person.
  person.blob.visible = !far
  // A rigged person also draws the LOD their distance asks for.
  if (person.rig && !far) showLod(person.rig, lodAt(distance) ?? 2)
}

export interface PersonStyle {
  shirt: number
  hair: number
  skin?: number
  /** Taller, and a brighter shirt: the user's own character. */
  user?: boolean
}

/** The placeholder's joints: a figure of boxes, standing with its feet at y = 0. */
function boxFigure(body: Group, style: PersonStyle, skin: number) {
  const hips = 0.82
  const legs = (x: number) => {
    const leg = new Group()
    leg.position.set(x, hips, 0)
    const shape = part(box, paint(0x22262e), 0.17, 0.82, 0.19)
    shape.position.y = -0.41
    leg.add(shape)
    body.add(leg)
    return leg
  }
  const legL = legs(-0.11)
  const legR = legs(0.11)

  const torso = new Group()
  torso.position.set(0, hips, 0)
  const chest = part(box, paint(style.shirt), 0.42, 0.62, 0.24)
  chest.position.y = 0.31
  torso.add(chest)
  body.add(torso)

  const arm = (x: number) => {
    const shoulder = new Group()
    shoulder.position.set(x, 0.58, 0)
    const shape = part(box, paint(style.shirt), 0.12, 0.6, 0.12)
    shape.position.y = -0.28
    const hand = part(sphere, paint(skin), 0.13, 0.13, 0.13)
    hand.position.y = -0.6
    shoulder.add(shape, hand)
    torso.add(shoulder)
    return shoulder
  }
  const armL = arm(-0.28)
  const armR = arm(0.28)

  const head = new Group()
  head.position.set(0, 0.7, 0)
  const skull = part(sphere, paint(skin), 0.3, 0.32, 0.3)
  skull.position.y = 0.1
  const hair = part(sphere, paint(style.hair), 0.32, 0.22, 0.32)
  hair.position.set(0, 0.2, -0.02)
  const nose = part(box, paint(skin), 0.05, 0.05, 0.06)
  nose.position.set(0, 0.1, 0.16)
  head.add(skull, hair, nose)
  torso.add(head)
  return { torso, head, armL, armR, legL, legR }
}

/** A person: N3's rigged character when a template is given, the placeholder of boxes otherwise. */
export function createPerson(style: PersonStyle, template?: Template): Person {
  const skin = style.skin ?? 0xe0b48c
  const group = new Group()
  const body = new Group()
  group.add(body)

  let rig: Rig | undefined
  let joints: ReturnType<typeof boxFigure>
  if (template) {
    rig = createRig(template)
    body.add(rig.root)
    // The joints belong to the placeholder; the rig has its own, so these stand in and are never drawn.
    joints = { torso: new Group(), head: new Group(), armL: new Group(), armR: new Group(), legL: new Group(), legR: new Group() }
    showLod(rig, 0)
  } else joints = boxFigure(body, style, skin)
  const { torso, head, armL, armR, legL, legR } = joints

  if (style.user) {
    // A ring at the feet, so the user can tell their own character at a glance.
    const ring = new Mesh(new TorusGeometry(0.42, 0.025, 8, 32), paint(0xffffff, { emissive: true }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.03
    body.add(ring)
  }

  const signal = new Group()
  signal.position.set(0, SIGNAL_Y, 0)
  const attention = mark(markAttention, 0xffb640)
  const question = mark(markQuestion, 0x6f8cff)
  signal.add(attention, question)
  signal.visible = false
  group.add(signal)

  const blob = new Mesh(blobGeometry, blobMaterial)
  blob.rotation.x = -Math.PI / 2
  blob.scale.setScalar(1.1)
  blob.position.y = 0.03
  group.add(blob)

  // Far away a person is a capsule of their height with a head, in the shirt's colour, and nothing that moves.
  const impostor = new Group()
  impostor.add(new Mesh(impostorShape, paint(style.shirt)))
  impostor.visible = false
  group.add(impostor)

  return { group, body, torso, head, armL, armR, legL, legR, signal, attention, question, blob, impostor, posedAt: -1, rig }
}

/** The person's look from ADE's `look` (stable for a title), and whether it is the user. */
export const styleOf = (look: { body: number; palette: number }): PersonStyle => ({
  shirt: personColor(look.palette),
  hair: hairColor(look.body),
})

/** Sits the person on a chair: lowered, legs forward. */
export function sit(person: Person, seated: boolean): void {
  // The far figure sits too: shorter, its seat on the chair's.
  person.impostor.scale.y = seated ? IMPOSTOR_SEATED : 1
  person.impostor.position.y = seated ? CHAIR_SEAT_TOP - 0.7 * IMPOSTOR_SEATED + 0.24 : 0
  if (person.rig) {
    // The clip seats the pelvis `seatY` above the root: raise the root until that is the chair's seat.
    person.body.position.y = seated ? CHAIR_SEAT_TOP - person.rig.seatY : 0
    return
  }
  person.body.position.y = seated ? -0.32 : 0
  person.legL.rotation.x = seated ? -Math.PI / 2 : 0
  person.legR.rotation.x = seated ? -Math.PI / 2 : 0
}

function applyJoints(p: Person, j: Joints): void {
  p.armL.rotation.set(j.armLx, 0, j.armLz)
  p.armR.rotation.set(j.armRx, 0, j.armRz)
  p.torso.rotation.set(j.torsoX, 0, 0)
  p.head.rotation.set(j.headX, j.headY, 0)
  p.body.rotation.y = j.bodyYaw
}

/** Poses a seated person for `look`, blended from the look before. `t` is the world clock in seconds. */
export function poseSeated(p: Person, look: StateLook, previous: StateLook, blend: number, t: number, seated = true): void {
  if (p.rig) {
    // Somebody standing (no desk for them) stands; the state's clip is a seated one.
    play(p.rig, seated ? ROLE_OF_POSE[look.pose] : "idle")
    advance(p.rig, t)
  } else applyJoints(p, mixJoints(jointsFor(previous.pose, t), jointsFor(look.pose, t), blend))
  setSignal(p, look, t)
}

/** How tall the mark is at its own size (metres): the octahedron's height. */
export const SIGNAL_SIZE = 0.32
/** Where the mark's middle is over a person's feet, at its own size. */
export const SIGNAL_Y = 1.95
/**
 * The least the mark is on the screen, as a share of the view's height: 18 pixels of 900. Nearer than where that
 * is its own size it keeps its own size; farther, it grows so that it never gets smaller than this.
 */
export const SIGNAL_MIN_SCREEN = 0.02

/** How many times its own size the mark is drawn at `distance` from a camera of vertical field `fov` (degrees). */
export function signalScale(distance: number, fov: number): number {
  const viewHeight = 2 * Math.tan((fov * Math.PI) / 360) * distance
  return Math.max(1, (SIGNAL_MIN_SCREEN * viewHeight) / SIGNAL_SIZE)
}

/**
 * The mark over the head, when the session needs the user. It is worked out for everyone in view, at any distance,
 * because it is the one thing about a far session that the user has to see: the figure may be a capsule, the mark is
 * not. It turns and bobs, it is drawn over whatever is in front of it with a dark outline, and it grows with the
 * distance so that it is never less than `SIGNAL_MIN_SCREEN` of the view.
 */
export function setSignal(p: Person, look: StateLook, t: number, distance = 0, fov = 58): void {
  p.signal.visible = look.signal !== "none"
  p.attention.visible = look.signal === "attention"
  p.question.visible = look.signal === "question"
  const grow = signalScale(distance, fov)
  p.signal.scale.setScalar(grow)
  // Grown, its lower tip stays where it was: over the head, not in it.
  p.signal.position.y = SIGNAL_Y + (SIGNAL_SIZE / 2) * (grow - 1) + Math.sin(t * 3) * 0.05
  p.signal.rotation.y = t * 2
}

/** The user walking: legs and arms swing with the speed. */
export function poseWalking(p: Person, speed: number, t: number): void {
  if (p.rig) {
    const role = roleAtSpeed(speed)
    play(p.rig, role, paceOf(role, speed))
    advance(p.rig, t)
    return
  }
  const swing = walkSwing(speed, t)
  p.legL.rotation.x = swing.leg
  p.legR.rotation.x = -swing.leg
  p.armL.rotation.set(swing.arm, 0, 0.08)
  p.armR.rotation.set(-swing.arm, 0, -0.08)
  p.torso.rotation.set(0, 0, 0)
  p.head.rotation.set(0, 0, 0)
}
