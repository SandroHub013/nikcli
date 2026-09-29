/**
 * The city as three.js objects: the ground and the square, the hologram, a
 * group per shop and a person per session, and the user's own character.
 *
 * This only draws what the `Town` and the player say. Everything it builds is
 * a plain scene graph, so it can be built and counted without a renderer; the
 * geometry and materials it makes for a shop are disposed when the shop goes.
 */

import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  Frustum,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  SphereGeometry,
  Sphere,
  Vector3,
  type PerspectiveCamera,
} from "three/webgpu"
import { createPerson, paint, poseSeated, poseWalking, setSignal, showDetail, sit, styleOf, type Person } from "./characters"
import { createHologram, type Hologram, type HologramKind } from "./hologram"
import { paintIsland } from "./water"
import { shopLook, type CityKit } from "./kit"
import { USER_BODY, bodyOfLook, type Cast } from "./rig"
import {
  CHAIR_SEAT_TOP,
  COMPUTER_HEIGHT,
  DESK_HALF,
  DESK_HEIGHT,
  DOOR_WIDTH,
  PLAZA_RADIUS,
  SHOP_DEPTH,
  SHOP_WIDTH,
  WALL_HEIGHT,
  deskLocal,
  islandHeight,
  standLocal,
  toWorld,
  wallsLocal,
  type Vec2,
} from "./layout"
import { detailAt, poseDue, shopInRange } from "./lod"
import { parseLogo, type Logo } from "./logo"
import type { Player } from "./controller"
import { GLOW_COLOR, lookOf } from "./states"
import { liftEase, type AgentEntity, type ShopEntity, type Town } from "./town"

const box = new BoxGeometry(1, 1, 1)
const plane = new PlaneGeometry(1, 1)

/** How far a shop is below the pavement when it has not come up yet. */
const SUNK = WALL_HEIGHT + 0.8

/**
 * A sphere that holds a whole shop: its half diagonal, the awning and the sign above it, and A2's bay window and
 * planters in front (the chiringuiti of the island's next stage get their own).
 */
export const SHOP_RADIUS = 8

/** The sign over the door, as N3 has its board: 3.5 wide, 0.56 tall, its middle 3.02 up and on the front face. */
const SIGN_WIDTH = 3.3
const SIGN_HEIGHT = 0.5
const SIGN_Y = 3.02
const SIGN_Z = SHOP_DEPTH / 2 + 0.16

/** A name, drawn as a texture for the sign. Text only: the name is never parsed as anything. */
function signTexture(name: string): CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = 1024
  canvas.height = 205
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  ctx.fillStyle = "#0f141c"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = "#38d8ff"
  ctx.lineWidth = 8
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
  ctx.fillStyle = "#f1ecec"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  const text = name.length > 26 ? `${name.slice(0, 25)}…` : name
  let size = 110
  do {
    ctx.font = `600 ${size}px system-ui, sans-serif`
    size -= 6
  } while (ctx.measureText(text).width > canvas.width - 90 && size > 30)
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 6)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

interface ShopView {
  group: Group
  /** The parts that need their own disposal. */
  own: Array<{ dispose(): void }>
  name: string
  desks: number
  deskGroup: Group
  monitors: Mesh[]
  /** The monitor each seated session works at. */
  screens: Map<string, Mesh>
  people: Map<string, Person>
  people3: Group
}

const WALL_MATERIAL = new MeshStandardMaterial({ color: 0x8a7560, roughness: 0.85 })
const FLOOR_MATERIAL = new MeshStandardMaterial({ color: 0x4a5060, roughness: 0.9 })
const DESK_MATERIAL = new MeshStandardMaterial({ color: 0x6a4e34, roughness: 0.6 })
const CHAIR_MATERIAL = new MeshStandardMaterial({ color: 0x20242c, roughness: 0.7 })
const MONITOR_BODY = new MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.4 })

export interface CityView {
  scene: Scene
  hologram: Hologram
  /** Brings the drawn shops and people in line with the town; call after `town.sync` and every frame. */
  update(town: Town, player: Player, t: number, camera: PerspectiveCamera): void
  /** The user's character. */
  user: Person
  /** The height of the ground under a point: the island's, or 0 with the placeholders. */
  groundAt(p: Vec2): number
  /** How many shop groups and people are drawn, for the tests. */
  counts(): { shops: number; people: number }
  /** The person drawn for a session, and the monitor at its desk, for the tests. */
  person(paneId: string): Person | undefined
  monitor(paneId: string): Mesh | undefined
  dispose(): void
}

function buildShop(entity: ShopEntity, kit?: CityKit): ShopView {
  const group = new Group()
  group.name = `shop:${entity.id}`
  const own: Array<{ dispose(): void }> = []

  if (kit) {
    // The file's shop: one of its variants and colours, by the project's name; the sign's text and the monitors' glow are ours.
    const look = shopLook(entity.shop.name, kit.variants)
    group.add(kit.shop(look.variant, look.tint))
  } else {
    const floor = new Mesh(box, FLOOR_MATERIAL)
    floor.scale.set(SHOP_WIDTH, 0.12, SHOP_DEPTH)
    floor.position.y = 0.06
    group.add(floor)
    for (const w of wallsLocal()) {
      const wall = new Mesh(box, WALL_MATERIAL)
      wall.scale.set(w.hx * 2, w.height, w.hz * 2)
      wall.position.set(w.x, w.height / 2, w.z)
      group.add(wall)
    }

    // A lit strip over the door.
    const strip = new Mesh(box, paint(0x38d8ff, { emissive: true }))
    strip.scale.set(DOOR_WIDTH, 0.08, 0.1)
    strip.position.set(0, WALL_HEIGHT - 0.1, SHOP_DEPTH / 2)
    group.add(strip)
  }

  const texture = signTexture(entity.shop.name)
  const signMaterial = texture
    ? new MeshBasicMaterial({ map: texture })
    : new MeshBasicMaterial({ color: new Color(0x0f141c) })
  own.push(signMaterial)
  if (texture) own.push(texture)
  const sign = new Mesh(plane, signMaterial)
  sign.scale.set(SIGN_WIDTH, SIGN_HEIGHT, 1)
  sign.position.set(0, SIGN_Y, SIGN_Z)
  group.add(sign)

  const deskGroup = new Group()
  group.add(deskGroup)
  const people3 = new Group()
  group.add(people3)

  return { group, own, name: entity.shop.name, desks: 0, deskGroup, monitors: [], screens: new Map(), people: new Map(), people3 }
}

/** The monitors own their material (its colour is the session's state), so it goes with them. */
function disposeScreens(view: ShopView): void {
  for (const monitor of view.monitors) (monitor.material as MeshBasicMaterial).dispose()
  view.monitors = []
  view.screens.clear()
}

/**
 * Draws `count` desks with their monitors and chairs, replacing the ones there. With N3's shop the desks and
 * chairs are in the file, all four always; what is drawn here is the glow over the monitors of the desks in use.
 */
function buildDesks(view: ShopView, count: number, kit?: CityKit): void {
  view.deskGroup.clear()
  disposeScreens(view)
  for (let i = 0; i < count; i++) {
    const at = deskLocal(i)
    const screen = new Mesh(plane, new MeshBasicMaterial({ color: GLOW_COLOR.off }))
    screen.scale.set(0.56, 0.32, 1)
    screen.position.set(at.computer.x, COMPUTER_HEIGHT, at.computer.z + 0.035)
    view.monitors.push(screen)
    if (kit) {
      view.deskGroup.add(screen)
      continue
    }
    const desk = new Mesh(box, DESK_MATERIAL)
    desk.scale.set(DESK_HALF.hx * 2, 0.06, DESK_HALF.hz * 2)
    desk.position.set(at.desk.x, DESK_HEIGHT, at.desk.z)
    const legs = new Mesh(box, DESK_MATERIAL)
    legs.scale.set(DESK_HALF.hx * 1.8, DESK_HEIGHT, 0.08)
    legs.position.set(at.desk.x, DESK_HEIGHT / 2, at.desk.z)
    const chair = new Mesh(box, CHAIR_MATERIAL)
    chair.scale.set(0.5, 0.06, 0.5)
    chair.position.set(at.chair.x, CHAIR_SEAT_TOP - 0.03, at.chair.z)
    const back = new Mesh(box, CHAIR_MATERIAL)
    back.scale.set(0.5, 0.5, 0.06)
    back.position.set(at.chair.x, CHAIR_SEAT_TOP + 0.25, at.chair.z + 0.25)
    const body = new Mesh(box, MONITOR_BODY)
    body.scale.set(0.62, 0.38, 0.05)
    body.position.set(at.computer.x, COMPUTER_HEIGHT, at.computer.z)
    view.deskGroup.add(desk, legs, chair, back, body, screen)
  }
  view.desks = count
}

export function createCityScene(logo: Logo = parseLogo(), kind: HologramKind = "tsl", cast?: Cast, kit?: CityKit): CityView {
  const scene = new Scene()
  scene.background = new Color(0x0b1226)
  // With the file's city the far towers fade into the haze at the foot of its sky dome, which is this colour.
  scene.fog = kit?.island ? new Fog(0x3a3560, 70, 330) : kit ? new Fog(0x211f31, 60, 300) : new Fog(0x0b1226, 70, 210)

  scene.add(new HemisphereLight(0xb4c6ff, 0x3a2e24, 1.6))
  scene.add(new AmbientLight(0x505878, 0.9))
  const sun = new DirectionalLight(0xffd0a0, 2.2)
  sun.position.set(-30, 45, 20)
  scene.add(sun)

  const ground = new Mesh(new CircleGeometry(140, 96), new MeshStandardMaterial({ color: 0x171a21, roughness: 0.95 }))
  ground.rotation.x = -Math.PI / 2
  // The file's paving lies at y = 0 too: at the same height the two fight for the same pixels in patches.
  if (kit) ground.position.y = -0.05
  scene.add(ground)
  if (kit) {
    // The file's plaza, or the island: its ground, the platform with the pedestal, the pier, the lagoon and the sky.
    scene.add(kit.plaza)
  } else {
    const plaza = new Mesh(new CircleGeometry(PLAZA_RADIUS, 72), new MeshStandardMaterial({ color: 0x2a303a, roughness: 0.8 }))
    plaza.rotation.x = -Math.PI / 2
    plaza.position.y = 0.02
    scene.add(plaza)
    const edge = new Mesh(new RingGeometry(PLAZA_RADIUS - 0.35, PLAZA_RADIUS, 96), new MeshBasicMaterial({ color: 0x38d8ff }))
    edge.rotation.x = -Math.PI / 2
    edge.position.y = 0.04
    scene.add(edge)

    // Lamps around the square: one instanced mesh of small bright spheres on poles.
    const lamps = new InstancedMesh(new SphereGeometry(0.2, 12, 8), new MeshBasicMaterial({ color: 0xffe2a8 }), 12)
    const lampMatrix = new Matrix4()
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      lampMatrix.makeTranslation(Math.sin(a) * (PLAZA_RADIUS + 0.9), 3.2, -Math.cos(a) * (PLAZA_RADIUS + 0.9))
      lamps.setMatrixAt(i, lampMatrix)
    }
    scene.add(lamps)
    const poles = new InstancedMesh(box, paint(0x20242c), 12)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      lampMatrix.makeScale(0.12, 3.2, 0.12).setPosition(Math.sin(a) * (PLAZA_RADIUS + 0.9), 1.6, -Math.cos(a) * (PLAZA_RADIUS + 0.9))
      poles.setMatrixAt(i, lampMatrix)
    }
    scene.add(poles)
  }

  // The island's lagoon and dusk sky are painted here, not by the file.
  const island = kit?.island ? paintIsland(kit.plaza, kind) : undefined

  // On N3's pedestal the hologram has no base of its own, and floats where the file's ring anchor says.
  const hologram = createHologram(logo, kind, kit ? { base: false, ringY: kit.ringY } : undefined)
  // The island's ground has heights (the deck, the lagoon's floor, the beach); the placeholders are flat.
  const groundAt = kit?.island ? islandHeight : () => 0
  // On the island the hologram stands on the deck: the file's ring anchor is measured from it.
  hologram.group.position.y += groundAt({ x: 0, z: 0 })
  scene.add(hologram.group)

  const user = createPerson({ shirt: 0xf1ecec, hair: 0x2a1e18, user: true }, cast?.get(USER_BODY))
  scene.add(user.group)

  const shops = new Map<string, ShopView>()

  function reconcileShop(entity: ShopEntity, town: Town): ShopView {
    let view = shops.get(entity.id)
    if (!view) {
      view = buildShop(entity, kit)
      shops.set(entity.id, view)
      scene.add(view.group)
    }
    if (view.name !== entity.shop.name) {
      // A renamed project: a new sign.
      for (const o of view.own) o.dispose()
      disposeScreens(view)
      scene.remove(view.group)
      shops.delete(entity.id)
      return reconcileShop(entity, town)
    }
    const wanted = town.deskCount(entity.id)
    if (view.desks !== wanted) buildDesks(view, wanted, kit)
    view.group.position.set(entity.placement.center.x, groundAt(entity.placement.center) - SUNK * (1 - liftEase(entity.lift)), entity.placement.center.z)
    view.group.rotation.y = entity.placement.yaw
    return view
  }

  const frustum = new Frustum()
  const projection = new Matrix4()
  const sphere = new Sphere()

  function reconcilePeople(view: ShopView, shop: ShopEntity, town: Town, t: number, camera: PerspectiveCamera, seen: boolean): void {
    const here = town.agentsOf(shop.id)
    const ids = new Set(here.map((a) => a.paneId))
    for (const [id, person] of view.people) {
      if (ids.has(id)) continue
      view.people3.remove(person.group)
      view.people.delete(id)
      view.screens.delete(id)
    }
    for (const monitor of view.monitors) (monitor.material as MeshBasicMaterial).color.setHex(GLOW_COLOR.off)
    for (const a of here) place(view, shop, a, t, camera, seen)
  }

  function place(view: ShopView, shop: ShopEntity, a: AgentEntity, t: number, camera: PerspectiveCamera, seen: boolean): void {
    let person = view.people.get(a.paneId)
    if (!person) {
      person = createPerson(styleOf(a.agent.look), cast?.get(bodyOfLook(a.agent.look)))
      view.people.set(a.paneId, person)
      view.people3.add(person.group)
    }
    const seat = a.seat
    const desk = seat.kind === "desk"
    const at = seat.kind === "desk" ? deskLocal(seat.desk).chair : standLocal(seat.index)
    person.group.position.set(at.x, 0, at.z)
    person.group.rotation.y = Math.PI
    sit(person, desk)
    // How far they are decides how much of them is drawn and how often their pose is worked out.
    const world = toWorld(shop.placement, at)
    const distance = Math.hypot(camera.position.x - world.x, camera.position.z - world.z)
    const detail = detailAt(distance)
    showDetail(person, detail, distance)
    if (seen && poseDue(detail, t, person.posedAt)) {
      poseSeated(person, a.look, a.previous, a.blend, t, desk)
      showDetail(person, detail, distance)
      person.posedAt = t
    }
    // The mark is not the figure's: it is worked out for whoever is in view, box or not.
    if (seen) setSignal(person, a.look, t, distance)
    // Someone who is away leaves an empty chair; the rest scale in and out.
    const present = a.look.present ? a.presence : 0
    person.group.visible = present > 0.01
    person.group.scale.setScalar(Math.max(0.001, present))
    if (desk) {
      const monitor = seat.kind === "desk" ? view.monitors[seat.desk] : undefined
      if (monitor) {
        (monitor.material as MeshBasicMaterial).color.setHex(GLOW_COLOR[a.look.glow])
        view.screens.set(a.paneId, monitor)
      }
    }
  }

  return {
    scene,
    groundAt,
    hologram,
    user,
    update(town, player, t, camera) {
      const seen = new Set<string>()
      // What the camera can see: a shop outside the view or beyond range is not drawn and its people are not posed.
      camera.updateMatrixWorld()
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projection)
      for (const entity of town.shops()) {
        seen.add(entity.id)
        const view = reconcileShop(entity, town)
        sphere.set(new Vector3(entity.placement.center.x, 1.5, entity.placement.center.z), SHOP_RADIUS)
        const inView =
          shopInRange({ x: camera.position.x, z: camera.position.z }, entity.placement.center, SHOP_RADIUS) && frustum.intersectsSphere(sphere)
        view.group.visible = inView
        reconcilePeople(view, entity, town, t, camera, inView)
      }
      for (const [id, view] of shops) {
        if (seen.has(id)) continue
        scene.remove(view.group)
        for (const o of view.own) o.dispose()
        disposeScreens(view)
        shops.delete(id)
      }
      user.group.position.set(player.x, groundAt(player), player.z)
      user.group.rotation.y = player.heading
      poseWalking(user, player.speed, t)
      hologram.update(t, camera)
      island?.update(t, camera)
    },
    person(paneId) {
      for (const v of shops.values()) {
        const found = v.people.get(paneId)
        if (found) return found
      }
      return undefined
    },
    monitor(paneId) {
      for (const v of shops.values()) {
        const found = v.screens.get(paneId)
        if (found) return found
      }
      return undefined
    },
    counts() {
      let people = 0
      for (const v of shops.values()) people += v.people.size
      return { shops: shops.size, people }
    },
    dispose() {
      for (const v of shops.values()) {
        for (const o of v.own) o.dispose()
        disposeScreens(v)
      }
      shops.clear()
    },
  }
}

export { lookOf }
