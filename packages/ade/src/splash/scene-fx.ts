/**
 * ADE Splash FX Overlay Animation:
 * Port of Master's prototype (design/ragu-splash/prova/index.html).
 *
 * Runs at ~30 FPS on an overlay transparent canvas (1672x941) atop scena.png:
 * - Rising & swaying steam puffs from the ragù pot (#efe2c8)
 * - Simmering bubbles growing and popping into droplets with gravity
 * - Glistening sparkles (+ arm shape) above the cooking area (#f6ead2)
 * - Developer eye blink (skin tone #fb9b60 + dark lid #1a0d08)
 * - Green terminal blinking cursor on laptop code (#5fa83a)
 *
 * Honors prefers-reduced-motion: canvas remains completely clear (static reference image only).
 */

export const B = 8 // block size in reference pixels
export const POT = { cx: 1000, cy: 445, rx: 190, ry: 30 }

export interface Bubble {
  x: number
  y: number
  born: number
  life: number
}

export interface Drop {
  x: number
  y: number
  vx: number
  vy: number
  born: number
}

export interface Puff {
  x: number
  y: number
  born: number
  life: number
  phase: number
  size: number
}

export interface Spark {
  x: number
  y: number
  born: number
  life: number
}

export interface FxState {
  bubbles: Bubble[]
  drops: Drop[]
  puffs: Puff[]
  sparks: Spark[]
  nextBubble: number
  nextPuff: number
  nextSpark: number
  nextBlink: number
  blinkUntil: number
}

export const rnd = (a: number, b: number): number => a + Math.random() * (b - a)
export const snap = (v: number): number => Math.round(v / B) * B

export const block = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  colour: string,
  size: number = 1,
): void => {
  ctx.fillStyle = colour
  ctx.fillRect(snap(x), snap(y), B * size, B * size)
}

export const inPot = (): [number, number] => {
  const t = rnd(0, Math.PI * 2)
  const r = Math.sqrt(Math.random())
  return [POT.cx + Math.cos(t) * POT.rx * r, POT.cy + Math.sin(t) * POT.ry * r]
}

export function createFxState(initialTime: number = performance.now()): FxState {
  return {
    bubbles: [],
    drops: [],
    puffs: [],
    sparks: [],
    nextBubble: 0,
    nextPuff: 0,
    nextSpark: 0,
    nextBlink: initialTime + 2500,
    blinkUntil: 0,
  }
}

export function spawnFx(state: FxState, now: number): void {
  // Bubbles inside pot
  if (now > state.nextBubble && state.bubbles.length < 6) {
    const [x, y] = inPot()
    state.bubbles.push({ x, y, born: now, life: rnd(700, 1100) })
    state.nextBubble = now + rnd(120, 380)
  }

  // Steam puffs rising from pot
  if (now > state.nextPuff && state.puffs.length < 5) {
    state.puffs.push({
      x: rnd(930, 1080),
      y: 390,
      born: now,
      life: rnd(2600, 3600),
      phase: rnd(0, 6),
      size: Math.random() < 0.5 ? 1 : 2,
    })
    state.nextPuff = now + rnd(500, 900)
  }

  // Sparkles around scene
  if (now > state.nextSpark && state.sparks.length < 4) {
    state.sparks.push({
      x: rnd(860, 1230),
      y: rnd(90, 370),
      born: now,
      life: rnd(600, 900),
    })
    state.nextSpark = now + rnd(250, 600)
  }

  // Developer eye blink
  if (now > state.nextBlink) {
    state.blinkUntil = now + 140
    state.nextBlink = now + rnd(2800, 4800)
  }
}

export function drawFx(
  ctx: CanvasRenderingContext2D,
  state: FxState,
  now: number,
  width: number = 1672,
  height: number = 941,
): void {
  ctx.clearRect(0, 0, width, height)

  // 1. Bubbles grow on the ragù surface, then pop into droplets
  for (let i = state.bubbles.length - 1; i >= 0; i--) {
    const b = state.bubbles[i]!
    const t = (now - b.born) / b.life
    if (t >= 1) {
      for (let k = 0; k < 3; k++) {
        state.drops.push({
          x: b.x,
          y: b.y - B,
          vx: rnd(-60, 60),
          vy: rnd(-260, -140),
          born: now,
        })
      }
      state.bubbles.splice(i, 1)
      continue
    }
    if (t < 0.5) {
      block(ctx, b.x, b.y, "#e8501e")
    } else {
      block(ctx, b.x - B / 2, b.y - B, "#e8501e", 2)
      block(ctx, b.x - B / 2, b.y - B, "#ffb070")
    }
  }

  // 2. Popping droplets with gravity
  for (let i = state.drops.length - 1; i >= 0; i--) {
    const d = state.drops[i]!
    const s = (now - d.born) / 1000
    if (s > 0.8) {
      state.drops.splice(i, 1)
      continue
    }
    block(
      ctx,
      d.x + d.vx * s,
      d.y + d.vy * s + 420 * s * s,
      s < 0.4 ? "#f0602a" : "#c8300f",
    )
  }

  // 3. Steam rising and swaying sinusoidally from pot
  for (let i = state.puffs.length - 1; i >= 0; i--) {
    const p = state.puffs[i]!
    const t = (now - p.born) / p.life
    if (t >= 1) {
      state.puffs.splice(i, 1)
      continue
    }
    const y = p.y - t * 320
    const x = p.x + Math.sin(p.phase + t * 5) * 22
    ctx.globalAlpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85)
    block(ctx, x, y, "#efe2c8", p.size)
    if (p.size === 2 && t < 0.6) {
      block(ctx, x + B * 2, y + B, "#efe2c8")
    }
    ctx.globalAlpha = 1
  }

  // 4. Sparkles (+ arm cross shape)
  for (let i = state.sparks.length - 1; i >= 0; i--) {
    const s = state.sparks[i]!
    const t = (now - s.born) / s.life
    if (t >= 1) {
      state.sparks.splice(i, 1)
      continue
    }
    const arm = t < 0.3 || t > 0.7 ? 0 : 1
    block(ctx, s.x, s.y, "#f6ead2")
    if (arm) {
      block(ctx, s.x - B, s.y, "#f6ead2")
      block(ctx, s.x + B, s.y, "#f6ead2")
      block(ctx, s.x, s.y - B, "#f6ead2")
      block(ctx, s.x, s.y + B, "#f6ead2")
    }
  }

  // 5. Developer eye blink
  if (now < state.blinkUntil) {
    ctx.fillStyle = "#fb9b60"
    ctx.fillRect(601, 244, 42, 32)
    ctx.fillRect(674, 241, 29, 34)
    ctx.fillStyle = "#1a0d08"
    ctx.fillRect(603, 262, 38, 6)
    ctx.fillRect(676, 262, 25, 6)
  }

  // 6. Laptop terminal blinking cursor
  if (Math.floor(now / 530) % 2 === 0) {
    ctx.fillStyle = "#5fa83a"
    ctx.fillRect(440, 456, 10, 12)
  }
}
