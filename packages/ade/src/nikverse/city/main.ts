/**
 * The city's entry, the one file the world bundle is built from: it makes the
 * renderer, reads the keyboard and the mouse, and runs the loop.
 *
 * `WebGPURenderer` when the frame has WebGPU, the classic `WebGLRenderer`
 * otherwise (`renderers.ts`); the scene is the same, and only the hologram's
 * materials differ. The loop has three ways to draw (`schedule.ts`): every frame
 * while something moves, 15 a second while only the hologram turns, and nothing
 * once ten quiet seconds have passed, until an event. Paused, it draws nothing
 * and holds no timer.
 *
 * `?check=logo` skips the city: it draws the logo flat and front-on at four
 * pixels per SVG unit, for the comparison with the SVG.
 */

import { quietLoop } from "./quiet-loop"
import { NoToneMapping, PerspectiveCamera, Raycaster, RenderTarget, Vector2, WebGPURenderer } from "three/webgpu"
import { WebGLRenderer } from "three"
import {
  NO_INPUT,
  cameraGoal,
  follow,
  inputKey,
  lookAround,
  spawnPlayer,
  startOrbit,
  stepPlayer,
  zoom,
  type Input,
  type Orbit,
  type Player,
} from "./controller"
import { keyCommand, nearestPickable, pickWithRay, type Pickable, type Ray } from "./interaction"
import type { Box } from "./layout"
import { CHECK_PIXELS_PER_UNIT, logoCheck } from "./hologram"
import { parseLogo } from "./logo"
import { loadLevel } from "./load-level"
import { movingIntervalMs, probeGpu, resolveLevel, type LevelId } from "./quality"
import { chooseRenderer, type Backend, type DrawingSurface } from "./renderers"
import type { Cast } from "./rig"
import type { GpuTiming } from "./bench"
import { benchScaled, hasTimestampQuery, liveGpuTimer } from "./gpu-idle"
import { createGovernor } from "./resolution"
import { createPictureDecoder, type Ktx2Support } from "./ktx2"
import { disposeTree, releaseRenderer } from "./release"
import { startShot } from "./shot-handle"
import { STILL_INTERVAL_MS, drawMode, pace, shouldSavePosition, type DrawMode } from "./schedule"
import { createTown, type Picture } from "./town"
import { createCityScene } from "./view"

/** Where the character stands: what ADE keeps for it between visits. */
export interface Spot {
  x: number
  z: number
  heading: number
}

export interface CityDeps {
  win: Window & typeof globalThis
  /** A command for ADE; ADE checks it against its own allowlist. */
  send(command: unknown): void
  /** ADE's picture as the world holds it right now. */
  picture(): Picture
  mode: "city" | "logo-check"
  /** Draw with the classic renderer even where WebGPU exists, to compare the two (`?renderer=classic`). */
  classic?: boolean
  /** The level asked for (`?quality=`): `auto`, or a level's id. Whatever the machine cannot run is lowered (`quality.ts`). */
  quality?: string
  /**
   * For measuring, and only through the bench's door (`?bench=1` or `?shot=`): the samples of the antialiasing (4, or 1 for none; WebGPU has
   * no 2) and the ceiling of the dynamic resolution's scale. Absent, a level is what it is.
   */
  tune?: { samples?: 1 | 4; maxScale?: number }
  /** The bench's shot (`?shot=N`, 1 to 8): the page draws the fixed scene from that camera once, and keeps the picture (`shot-handle.ts`). */
  shot?: number
  /** Where the assets are, with the final slash; the page's own `assets/` when not given. */
  assets?: string
  /** Tells ADE where the character is, so that a reload of the frame can stand it there again. */
  savePosition?(spot: Spot): void
}

export interface CityHandle {
  /** The picture changed: take it. */
  sync(): void
  pause(): void
  resume(): void
  /** Where ADE says the character stood: taken only if the user has not moved yet. */
  restore(spot: Spot): void
  info(): { backend: Backend; mode: CityDeps["mode"]; level?: LevelId; cast: boolean; kit: boolean }
  /** Draws the current view `frames` times back to back and says how long the GPU took (the gate's and the bench's number). */
  bench?(frames?: number): Promise<GpuTiming>
  dispose(): void
}

/** The projector under the hologram: the character walks around it, not through it. */
const PROJECTOR: Box = { cx: 0, cz: 0, hx: 3.1, hz: 3.1, yaw: 0, height: 0.62 }

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

async function pickRenderer(deps: CityDeps, check: boolean, classic: boolean) {
  const doc = deps.win.document
  return chooseRenderer<HTMLCanvasElement>({
    makeCanvas: () => {
      const canvas = doc.createElement("canvas")
      canvas.className = "city"
      canvas.tabIndex = 0
      return canvas
    },
    gpu: (deps.win.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu,
    options: { antialias: !check && deps.tune?.samples !== 1, alpha: check },
    classic,
    createWebGPU: async (canvas, options) => {
      const renderer = new WebGPURenderer({ canvas, antialias: options.antialias, alpha: options.alpha })
      await renderer.init()
      // three's own frame loop would run at every vsync for a city that draws nothing.
      if (!quietLoop(renderer)) console.warn("[nikverse] il ciclo interno di three non e stato fermato")
      // Never its WebGL backend: that is what the classic renderer is for.
      if (!(renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend) {
        renderer.dispose()
        throw new Error("WebGPURenderer ha scelto WebGL")
      }
      return renderer as unknown as DrawingSurface
    },
    createClassic: (canvas, options) =>
      new WebGLRenderer({ canvas, antialias: options.antialias, alpha: options.alpha }) as unknown as DrawingSurface,
  })
}

export { decodePicture, loadCast } from "./assets"
export { createPictureDecoder } from "./ktx2"
export { loadKit } from "./kit"
export { LEVELS, resolveLevel } from "./quality"

export async function startCity(deps: CityDeps): Promise<CityHandle> {
  const { win } = deps
  const doc = win.document
  const stage = doc.getElementById("stage")
  if (!stage) throw new Error("manca #stage nella pagina del mondo")

  const check = deps.mode === "logo-check"
  // The level decides the renderer and the assets: what the machine has, and what was asked for.
  const gpu = check ? { webgpu: false, dedicated: false } : await probeGpu((win.navigator as Navigator & { gpu?: never }).gpu)
  const resolved = resolveLevel(deps.quality, gpu)
  const level = resolved.level
  const chosen = await pickRenderer(deps, check, deps.classic === true || level.renderer === "classic")
  const { renderer, canvas, backend } = chosen
  stage.append(canvas)
  renderer.toneMapping = NoToneMapping
  doc.documentElement.dataset.backend = backend
  if (chosen.why) doc.documentElement.dataset.backendWhy = chosen.why

  if (check) return logoCheckHandle(deps, renderer, canvas, backend)

  // N3's people, shop and plaza; what does not load stays a placeholder, and the page says why. The pictures
  // are KTX2 in the GPU's own format, or PNG.
  const base = deps.assets ?? new URL("./assets/", win.location.href).href
  const pictures = createPictureDecoder(renderer as unknown as Ktx2Support)
  const loaded = await loadLevel(level, {
    base,
    fetchBytes: async (url) => {
      const response = await win.fetch(url)
      if (!response.ok) throw new Error(`${response.status}`)
      return response.arrayBuffer()
    },
    decode: pictures.decode,
  })
  pictures.dispose()
  const { cast, kit } = loaded
  const data = doc.documentElement.dataset
  data.quality = level.id
  data.assets = loaded.assets.id
  // Why the level is what it is, and what is plain or missing in it.
  data.qualityWhy = [resolved.why, ...loaded.notes].filter(Boolean).join(" | ").slice(0, 600)
  data.cast = cast ? "ok" : "failed"
  data.kit = kit ? "ok" : "failed"

  const logo = parseLogo()
  const town = createTown()
  const view = createCityScene(logo, backend === "webgpu" ? "tsl" : "shader", cast, kit)
  const camera = new PerspectiveCamera(58, 1, 0.1, 400)
  // The bench's page: the fixed scene from one camera, drawn once (`?shot=N`).
  if (deps.shot !== undefined)
    return startShot({ win, shot: deps.shot, renderer, canvas, backend, level: level.id, view, town, camera, dynamic: level.dynamicResolution && backend === "webgpu" && hasTimestampQuery(renderer), tune: { ...deps.tune, maxScale: deps.tune?.maxScale ?? level.maxScale }, cast: cast !== undefined, kit: kit !== undefined })
  let player: Player = spawnPlayer()
  let orbit: Orbit = startOrbit()
  let keys: Input = { ...NO_INPUT }
  let eye: [number, number, number] | undefined
  let look: [number, number, number] = [0, 1.4, 0]
  let dragging = false
  let running = true
  /** The GPU is being timed: the loop draws nothing until it is done, so that the frames counted are the only ones. */
  let benching = false
  let moved = false
  let wasMoving = false
  let sentAt = 0
  let clock = 0
  let last = 0
  let nextDraw = 0
  let lastActivity = win.performance.now()
  let mode: DrawMode = "moving"
  let handle: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sized = false
  const movingInterval = movingIntervalMs(level)
  let boxes: Box[] = [PROJECTOR]
  let boxesStale = true
  let hintPane: string | undefined
  const hint = doc.getElementById("hint")
  const raycaster = new Raycaster()
  const pointer = new Vector2()

  // Dynamic resolution: where the level asks for it and the GPU has a clock, the frame's pixels follow its GPU time.
  const gpuClock = level.dynamicResolution && backend === "webgpu" ? liveGpuTimer(renderer) : undefined
  const maxScale = deps.tune?.maxScale ?? level.maxScale
  const samples = deps.tune?.samples ?? 4
  const governor = gpuClock ? createGovernor(maxScale, undefined, maxScale) : undefined
  let renderScale = maxScale
  let sampling = false
  let framesDrawn = 0
  doc.documentElement.dataset.renderScale = String(renderScale)

  const resize = () => {
    const w = Math.max(1, stage.clientWidth)
    const h = Math.max(1, stage.clientHeight)
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, level.pixelRatio) * renderScale)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    sized = true
    wake()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(stage)

  const world = () => {
    if (boxesStale) {
      boxes = [PROJECTOR, ...town.boxes()]
      boxesStale = false
    }
    return { boxes, radius: town.radius() }
  }

  const rayAt = (clientX: number, clientY: number): Ray => {
    const rect = canvas.getBoundingClientRect()
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
    raycaster.setFromCamera(pointer, camera as never)
    const { origin, direction } = raycaster.ray
    return { ox: origin.x, oy: origin.y, oz: origin.z, dx: direction.x, dy: direction.y, dz: direction.z }
  }

  const pickAt = (clientX: number, clientY: number): Pickable | undefined =>
    pickWithRay(rayAt(clientX, clientY), town.pickables(), town.walls())

  const busy = () =>
    town.animating || dragging || Object.values(keys).some(Boolean) || player.speed > 0.05 || !sized || !eye

  function frame(ts: number) {
    handle = undefined
    if (!running || benching) return
    const dt = last === 0 ? 0.016 : Math.min(0.1, (ts - last) / 1000)
    last = ts
    clock += dt

    const wasAnimating = town.animating
    town.tick(dt)
    if (wasAnimating || town.animating) boxesStale = true
    player = stepPlayer(player, keys, orbit.yaw, dt, world())

    const goal = cameraGoal(player, orbit)
    if (!eye) {
      eye = goal.eye
      look = goal.look
    } else {
      eye = [follow(eye[0], goal.eye[0], dt), follow(eye[1], goal.eye[1], dt), follow(eye[2], goal.eye[2], dt)]
      look = [follow(look[0], goal.look[0], dt), follow(look[1], goal.look[1], dt), follow(look[2], goal.look[2], dt)]
    }
    camera.position.set(eye[0], eye[1], eye[2])
    camera.lookAt(look[0], look[1], look[2])

    view.update(town, player, clock, camera)
    // Where the character is, for the render check: rounded, and written only when it changes.
    const at = `${player.x.toFixed(1)},${player.z.toFixed(1)}`
    if (doc.documentElement.dataset.at !== at) doc.documentElement.dataset.at = at

    // ADE keeps the place: when the character stops, and every few seconds while it walks.
    const walking = player.speed > 0.05
    if (moved && deps.savePosition && shouldSavePosition({ moving: wasMoving, sentAt }, { moving: walking, at: ts })) {
      deps.savePosition({ x: player.x, z: player.z, heading: player.heading })
      sentAt = ts
    }
    wasMoving = walking

    const near = nearestPickable(player, town.pickables())
    if (near?.paneId !== hintPane) {
      hintPane = near?.paneId
      if (hint) {
        const title = near ? deps.picture().agents.get(near.paneId)?.title : undefined
        hint.hidden = !near
        hint.textContent = near ? `E · apri ${title ?? "la sessione"}` : ""
      }
    }

    const moving = busy()
    if (moving) lastActivity = ts
    const now: DrawMode = drawMode({ moving, sinceActivityMs: ts - lastActivity })
    if (now !== mode) {
      mode = now
      doc.documentElement.dataset.drawMode = mode
    }
    // Immobile: nothing to draw until an event wakes the loop; the last picture stays on the screen.
    if (mode === "immobile") return
    // Moving draws at the level's frame rate (Bassa 30, Media and Alta 60, never more); standing, 15.
    const paced = pace(ts, nextDraw, mode === "moving" ? movingInterval : STILL_INTERVAL_MS)
    nextDraw = paced.next
    if (paced.draw) {
      // One frame in three of the moving mode is timed by the GPU's clock: about twenty a second, no cost for the rest.
      const timed = governor !== undefined && mode === "moving" && !sampling && ++framesDrawn % 3 === 0
      if (timed) gpuClock!.begin()
      renderer.render(view.scene, camera)
      if (timed) {
        sampling = true
        void gpuClock!
          .end()
          .then((ms) => {
            const next = governor!.push(ms)
            if (next === undefined || !running) return
            renderScale = next
            doc.documentElement.dataset.renderScale = String(next)
            resize()
          })
          .catch(() => {})
          .finally(() => (sampling = false))
      }
      // A count of the frames drawn, for the render check: pausing must stop it.
      const counter = win as unknown as { __nikverseFrames?: number }
      counter.__nikverseFrames = (counter.__nikverseFrames ?? 0) + 1
      if (doc.documentElement.dataset.ready !== "1") doc.documentElement.dataset.ready = "1"
    }
    schedule(mode === "moving")
  }

  function schedule(active: boolean) {
    if (!running || handle !== undefined || timer !== undefined) return
    if (active) handle = win.requestAnimationFrame(frame)
    else
      timer = setTimeout(() => {
        timer = undefined
        if (running && handle === undefined) handle = win.requestAnimationFrame(frame)
      }, STILL_INTERVAL_MS)
  }

  /** Something happened: it counts as activity, and the loop leaves its rest at once. */
  function wake() {
    if (!running) return
    lastActivity = win.performance.now()
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (handle === undefined) handle = win.requestAnimationFrame(frame)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Shortcuts with Ctrl, Alt or Meta are ADE's: the world's own handler forwards them.
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const command = event.repeat ? undefined : keyCommand(event.code, player, town.pickables())
    if (command) {
      event.preventDefault()
      deps.send(command)
      wake()
      return
    }
    const key = inputKey(event.code)
    if (!key) return
    event.preventDefault()
    if (!keys[key]) {
      keys = { ...keys, [key]: true }
      moved = true
      wake()
    }
  }
  const onKeyUp = (event: KeyboardEvent) => {
    const key = inputKey(event.code)
    if (key && keys[key]) keys = { ...keys, [key]: false }
  }
  const onBlur = () => {
    keys = { ...NO_INPUT }
    dragging = false
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const picked = pickAt(event.clientX, event.clientY)
    if (picked) {
      deps.send({ cmd: "open-session", paneId: picked.paneId })
      wake()
      return
    }
    // The camera turns by dragging, as in The Sims: WebView2 gives a frame no pointer lock.
    dragging = true
    wake()
  }
  const onPointerUp = () => {
    dragging = false
  }
  // On the window, so that a drag goes on when the mouse leaves the canvas; the pointer over the canvas alone is a hover.
  const onPointerMove = (event: PointerEvent) => {
    if (dragging) {
      orbit = lookAround(orbit, event.movementX, event.movementY)
      wake()
      return
    }
    if (event.target !== canvas) return
    canvas.style.cursor = pickAt(event.clientX, event.clientY) ? "pointer" : "default"
    // The mouse over the world is activity: the city does not fall asleep under it.
    lastActivity = win.performance.now()
    if (mode === "immobile") wake()
  }
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    orbit = zoom(orbit, event.deltaY)
    wake()
  }

  win.addEventListener("keydown", onKeyDown)
  win.addEventListener("keyup", onKeyUp)
  win.addEventListener("blur", onBlur)
  canvas.addEventListener("pointerdown", onPointerDown)
  win.addEventListener("pointerup", onPointerUp)
  win.addEventListener("pointermove", onPointerMove)
  canvas.addEventListener("wheel", onWheel, { passive: false })

  town.sync(deps.picture())
  resize()

  return {
    sync() {
      town.sync(deps.picture())
      boxesStale = true
      wake()
    },
    pause() {
      running = false
      if (handle !== undefined) win.cancelAnimationFrame(handle)
      if (timer !== undefined) clearTimeout(timer)
      handle = undefined
      timer = undefined
      keys = { ...NO_INPUT }
      dragging = false
    },
    resume() {
      if (running) return
      running = true
      last = 0
      wake()
    },
    restore(spot) {
      // Only before the user has taken the character anywhere, and only for a place that is a place.
      if (moved || !finite(spot?.x) || !finite(spot?.z) || !finite(spot?.heading)) return
      player = { ...player, x: spot.x, z: spot.z, heading: spot.heading, speed: 0, vx: 0, vz: 0 }
      // The camera stands behind the character again, and looks the way it faces.
      orbit = { ...orbit, yaw: spot.heading + Math.PI }
      eye = undefined
      wake()
    },
    info: () => ({ backend, mode: deps.mode, level: level.id, cast: cast !== undefined, kit: kit !== undefined }),
    async bench(frames = 240) {
      if (benching) throw new Error("il banco è già in corso")
      benching = true
      if (handle !== undefined) win.cancelAnimationFrame(handle)
      if (timer !== undefined) clearTimeout(timer)
      handle = undefined
      timer = undefined
      // Into a target for WebGPU: the canvas would hold each frame for the display (see `benchDraw`). Where the level moves its
      // resolution, the view is timed at the scales the governor would pick, from the size the canvas has at scale 1.
      try {
        return await benchScaled({
          renderer,
          backend,
          scene: view.scene,
          camera,
          makeTarget: (width, height) => new RenderTarget(width, height, { samples }),
          maxScale,
          width: Math.round(canvas.width / renderScale),
          height: Math.round(canvas.height / renderScale),
          dynamic: governor !== undefined,
          frames,
        })
      } finally {
        benching = false
        last = 0
        wake()
      }
    },
    dispose() {
      running = false
      if (handle !== undefined) win.cancelAnimationFrame(handle)
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
      win.removeEventListener("keydown", onKeyDown)
      win.removeEventListener("keyup", onKeyUp)
      win.removeEventListener("blur", onBlur)
      win.removeEventListener("pointerup", onPointerUp)
      win.removeEventListener("pointermove", onPointerMove)
      view.dispose()
      // Everything the scene holds goes back to the GPU now, not when the frame's process is collected.
      disposeTree(view.scene)
      releaseRenderer(renderer)
      canvas.remove()
    },
  }
}

/** The check: the logo flat, front-on, at exactly four pixels per SVG unit, drawn once. */
function logoCheckHandle(deps: CityDeps, renderer: DrawingSurface, canvas: HTMLCanvasElement, backend: Backend): CityHandle {
  const { scene, camera, width, height } = logoCheck(parseLogo())
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.setClearColor(0x000000, 0)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  renderer.render(scene, camera)
  deps.win.document.documentElement.dataset.ready = "1"
  deps.win.document.documentElement.dataset.checkPixels = String(CHECK_PIXELS_PER_UNIT)
  return {
    sync() {},
    pause() {},
    resume() {},
    restore() {},
    info: () => ({ backend, mode: "logo-check", cast: false, kit: false }),
    dispose() {
      disposeTree(scene)
      releaseRenderer(renderer)
      canvas.remove()
    },
  }
}
