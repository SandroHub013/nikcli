/**
 * The placeholder people: clean geometric figures made of boxes and a sphere,
 * standing until N3's models replace them through the asset manifest.
 *
 * A person is a `Group` with named joints so the pose code can turn them. The
 * feet are at y = 0 and it faces local +z; a seated person is the same figure
 * lowered onto a chair with the legs turned forward.
 */

import {
  BoxGeometry,
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
import { jointsFor, mixJoints, walkSwing, type Joints } from "./pose"
import type { StateLook } from "./states"
import { hairColor, personColor } from "./states"

const box = new BoxGeometry(1, 1, 1)
const sphere = new SphereGeometry(0.5, 20, 14)

const materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>()

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
  /** The whole figure as one box, drawn instead of the figure when it is far. */
  impostor: Mesh
  /** The pose was last worked out at this time (seconds), for the far people that update ten times a second. */
  posedAt: number
}

const blobGeometry = new CircleGeometry(0.5, 20)
const blobMaterial = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })

/** Draws the figure or its impostor: near, the figure with its shadow; far, the one box. */
export function showDetail(person: Person, detail: "full" | "slow" | "impostor"): void {
  const far = detail === "impostor"
  person.body.visible = !far
  person.signal.visible = person.signal.visible && !far
  person.impostor.visible = far
}

export interface PersonStyle {
  shirt: number
  hair: number
  skin?: number
  /** Taller, and a brighter shirt: the user's own character. */
  user?: boolean
}

export function createPerson(style: PersonStyle): Person {
  const skin = style.skin ?? 0xe0b48c
  const group = new Group()
  const body = new Group()
  group.add(body)

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

  if (style.user) {
    // A ring at the feet, so the user can tell their own character at a glance.
    const ring = new Mesh(new TorusGeometry(0.42, 0.025, 8, 32), paint(0xffffff, { emissive: true }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.03
    body.add(ring)
  }

  const signal = new Group()
  signal.position.set(0, 1.95, 0)
  const attention = new Mesh(new OctahedronGeometry(0.16), paint(0xffb640, { emissive: true }))
  const question = new Mesh(new TorusGeometry(0.13, 0.045, 8, 20), paint(0x6f8cff, { emissive: true }))
  signal.add(attention, question)
  signal.visible = false
  group.add(signal)

  const blob = new Mesh(blobGeometry, blobMaterial)
  blob.rotation.x = -Math.PI / 2
  blob.scale.setScalar(1.1)
  blob.position.y = 0.03
  group.add(blob)

  // Far away a person is a coloured box of their height: the shirt's colour, and nothing that moves.
  const impostor = part(box, paint(style.shirt), 0.5, 1.7, 0.3)
  impostor.position.y = 0.85
  impostor.visible = false
  group.add(impostor)

  return { group, body, torso, head, armL, armR, legL, legR, signal, attention, question, blob, impostor, posedAt: -1 }
}

/** The person's look from ADE's `look` (stable for a title), and whether it is the user. */
export const styleOf = (look: { body: number; palette: number }): PersonStyle => ({
  shirt: personColor(look.palette),
  hair: hairColor(look.body),
})

/** Sits the person on a chair: lowered, legs forward. */
export function sit(person: Person, seated: boolean): void {
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
export function poseSeated(p: Person, look: StateLook, previous: StateLook, blend: number, t: number): void {
  applyJoints(p, mixJoints(jointsFor(previous.pose, t), jointsFor(look.pose, t), blend))
  p.signal.visible = look.signal !== "none"
  p.attention.visible = look.signal === "attention"
  p.question.visible = look.signal === "question"
  // The mark turns and bobs, so a session that needs the user reads from across the square.
  p.signal.position.y = 1.95 + Math.sin(t * 3) * 0.05
  p.signal.rotation.y = t * 2
}

/** The user walking: legs and arms swing with the speed. */
export function poseWalking(p: Person, speed: number, t: number): void {
  const swing = walkSwing(speed, t)
  p.legL.rotation.x = swing.leg
  p.legR.rotation.x = -swing.leg
  p.armL.rotation.set(swing.arm, 0, 0.08)
  p.armR.rotation.set(-swing.arm, 0, -0.08)
  p.torso.rotation.set(0, 0, 0)
  p.head.rotation.set(0, 0, 0)
}
