import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import * as THREE from "three"
import "./splash.css"

export interface SplashProps {
  /** Hidden when this goes false. The fade is handled here. */
  visible: boolean
  /** What it says it is doing, under the scene. */
  status?: string
  /** Optional callback to dismiss or skip the splash early. */
  onDismiss?: () => void
}

const FADE_MS = 600
const NUM_PARTICLES = 2000
const ASCII_CHARS = [" ", ".", ":", "-", "=", "+", "*", "%", "#", "@", "N", "i", "K"]

/**
 * Concept 04: Fullscreen 3D ASCII Typography (NiK).
 *
 * Perfectly centered typography in 3D and 2D.
 * All mouse interaction with the text is disabled: the typography stays steady,
 * exhibiting only its natural organic breathing.
 */
export function Splash(props: SplashProps) {
  let canvasContainerRef: HTMLDivElement | undefined
  let asciiLayerRef: HTMLPreElement | undefined
  const [gone, setGone] = createSignal(false)

  onMount(() => {
    const container = canvasContainerRef
    const asciiLayer = asciiLayerRef
    if (!container || !asciiLayer) return

    let animId: number
    let stopped = false

    // Check if WebGL is supported (avoids crashes in headless HappyDOM test runners)
    let hasWebGL = false
    try {
      const testCanvas = document.createElement("canvas")
      hasWebGL = Boolean(
        window.WebGLRenderingContext &&
          (testCanvas.getContext("webgl") || testCanvas.getContext("experimental-webgl"))
      )
    } catch {
      hasWebGL = false
    }

    if (!hasWebGL) {
      // Graceful fallback for non-WebGL test environments
      asciiLayer.textContent = "   N   i   K   \n [ADE READY]"
      return
    }

    // ── Three.js Scene Setup ────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x07090e)

    const width = window.innerWidth || 800
    const height = window.innerHeight || 600

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(0, 0, 15)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance",
      })
    } catch {
      return
    }

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.appendChild(renderer.domElement)

    // ── Swarm Target Positions: Perfectly Symmetrical Typography "NiK" ──────
    const swarmTargets: THREE.Vector3[] = []
    const swarmPositions: THREE.Vector3[] = []

    function sampleLine(
      x1: number,
      y1: number,
      z1: number,
      x2: number,
      y2: number,
      z2: number,
      count: number
    ) {
      for (let i = 0; i < count; i++) {
        const t = i / count
        swarmTargets.push(
          new THREE.Vector3(
            x1 + (x2 - x1) * t + (Math.random() - 0.5) * 0.25,
            y1 + (y2 - y1) * t + (Math.random() - 0.5) * 0.25,
            z1 + (z2 - z1) * t + (Math.random() - 0.5) * 0.4
          )
        )
      }
    }

    // Letter N strokes (880 points) - centered around x = -2.9
    sampleLine(-4.2, -3.5, 0, -4.2, 3.5, 0, 280)
    sampleLine(-4.2, 3.5, 0, -1.6, -3.5, 0, 340)
    sampleLine(-1.6, -3.5, 0, -1.6, 3.5, 0, 260)

    // Letter I strokes (360 points) - centered at x = 0.0
    sampleLine(0.0, -2.5, 0, 0.0, 2.0, 0, 260)
    sampleLine(0.0, 3.0, 0, 0.0, 3.5, 0, 100)

    // Letter K strokes (760 points) - centered around x = +2.9
    sampleLine(1.6, -3.5, 0, 1.6, 3.5, 0, 280)
    sampleLine(1.6, 0.2, 0, 4.2, 3.5, 0, 240)
    sampleLine(1.6, 0.2, 0, 4.2, -3.5, 0, 240)

    // Points Buffer Geometry
    const pGeo = new THREE.BufferGeometry()
    const posArray = new Float32Array(NUM_PARTICLES * 3)
    for (let i = 0; i < NUM_PARTICLES; i++) {
      const tgt = swarmTargets[i] || new THREE.Vector3(0, 0, 0)
      posArray[i * 3] = tgt.x + (Math.random() - 0.5) * 0.4
      posArray[i * 3 + 1] = tgt.y + (Math.random() - 0.5) * 0.4
      posArray[i * 3 + 2] = tgt.z + (Math.random() - 0.5) * 0.4
      swarmPositions.push(
        new THREE.Vector3(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2])
      )
    }
    pGeo.setAttribute("position", new THREE.BufferAttribute(posArray, 3))

    const pMat = new THREE.PointsMaterial({
      size: 0.28,
      color: 0x58a6ff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
    })
    const particleSystem = new THREE.Points(pGeo, pMat)

    // Root Group: Locked at (0, 0, 0) - Dead center, zero rotation
    const activeGroup = new THREE.Group()
    activeGroup.add(particleSystem)
    activeGroup.position.set(0, 0, 0)
    activeGroup.rotation.set(0, 0, 0)
    scene.add(activeGroup)

    // ── Measure Monospace Font Dimensions for Exact Cell Alignment ─────────
    const measureSpan = document.createElement("span")
    measureSpan.style.fontFamily = "var(--ade-mono, 'Fira Code', 'JetBrains Mono', Consolas, monospace)"
    measureSpan.style.fontSize = "10px"
    measureSpan.style.letterSpacing = "1px"
    measureSpan.style.lineHeight = "10px"
    measureSpan.style.visibility = "hidden"
    measureSpan.style.position = "absolute"
    measureSpan.textContent = "M"
    document.body.appendChild(measureSpan)
    const measuredRect = measureSpan.getBoundingClientRect()
    const charW = measuredRect.width || 7
    const charH = measuredRect.height || 10
    document.body.removeChild(measureSpan)

    // ── ASCII Post-Processing Filter ────────────────────────────────────────
    const offscreenCanvas = document.createElement("canvas")
    const offscreenCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true })

    const updateAsciiRender = () => {
      if (!offscreenCtx) return

      const w = window.innerWidth
      const h = window.innerHeight

      const cols = Math.max(20, Math.floor(w / charW))
      const rows = Math.max(10, Math.floor(h / charH))

      offscreenCanvas.width = cols
      offscreenCanvas.height = rows

      offscreenCtx.drawImage(renderer.domElement, 0, 0, cols, rows)
      const imgData = offscreenCtx.getImageData(0, 0, cols, rows).data

      let str = ""
      const charCount = ASCII_CHARS.length - 1
      for (let y = 0; y < rows; y++) {
        const rowOffset = y * cols
        for (let x = 0; x < cols; x++) {
          const idx = (rowOffset + x) * 4
          const r = imgData[idx]!
          const g = imgData[idx + 1]!
          const b = imgData[idx + 2]!
          const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255
          const charIndex = Math.floor(brightness * charCount)
          str += ASCII_CHARS[charIndex]
        }
        str += "\n"
      }
      asciiLayer.textContent = str
    }

    // ── Animation Loop (NO MOUSE DEFLECTION) ─────────────────────────────────
    const clock = new THREE.Clock()
    const displacement = 0.25

    const animate = () => {
      if (stopped) return

      const time = clock.getElapsedTime()

      // Locked position and rotation (centered, no rotation)
      activeGroup.position.set(0, 0, 0)
      activeGroup.rotation.set(0, 0, 0)

      const positions = particleSystem.geometry.attributes.position.array as Float32Array

      for (let i = 0; i < NUM_PARTICLES; i++) {
        const cur = swarmPositions[i]!
        const target = swarmTargets[i]!

        // Pure organic breathing: NO mouse interaction
        const breathe = 1 + Math.sin(time * 2.0 + i * 0.02) * (0.05 + displacement * 0.3)
        const tx = target.x * breathe + Math.sin(time * 3 + i) * 0.08
        const ty = target.y * breathe + Math.cos(time * 2.5 + i) * 0.08
        const tz = target.z * breathe

        cur.x += (tx - cur.x) * 0.08
        cur.y += (ty - cur.y) * 0.08
        cur.z += (tz - cur.z) * 0.08

        positions[i * 3] = cur.x
        positions[i * 3 + 1] = cur.y
        positions[i * 3 + 2] = cur.z
      }

      particleSystem.geometry.attributes.position.needsUpdate = true

      renderer.render(scene, camera)
      updateAsciiRender()

      animId = requestAnimationFrame(animate)
    }

    animId = requestAnimationFrame(animate)

    // ── Window Resize Handling ──────────────────────────────────────────────
    const onResize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        props.onDismiss?.()
      }
    }

    window.addEventListener("resize", onResize)
    window.addEventListener("keydown", handleKeyDown)

    // ── Cleanup ─────────────────────────────────────────────────────────────
    onCleanup(() => {
      stopped = true
      cancelAnimationFrame(animId)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("keydown", handleKeyDown)

      pGeo.dispose()
      pMat.dispose()
      renderer.dispose()

      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement)
      }
    })
  })

  // Fade out smoothly when props.visible flips to false
  createEffect(() => {
    if (!props.visible) {
      const t = setTimeout(() => setGone(true), FADE_MS)
      onCleanup(() => clearTimeout(t))
    } else {
      setGone(false)
    }
  })

  return (
    <Show when={!gone()}>
      <div
        data-component="ade-splash"
        data-slot="ade-splash-root"
        data-leaving={!props.visible ? "" : undefined}
        onClick={() => props.onDismiss?.()}
        role="dialog"
        aria-label="ADE Onboarding — 3D ASCII Typography"
        aria-modal="true"
      >
        {/* Three.js Canvas Container (Offscreen WebGL source) */}
        <div
          ref={canvasContainerRef}
          data-slot="splash-canvas-container"
          aria-hidden="true"
        />

        {/* Real-time Centered 3D ASCII Typography */}
        <pre ref={asciiLayerRef} data-slot="ascii-layer" aria-hidden="true" />

        {/* CRT Scanlines & Vignette */}
        <div data-slot="splash-crt" aria-hidden="true" />
      </div>
    </Show>
  )
}
