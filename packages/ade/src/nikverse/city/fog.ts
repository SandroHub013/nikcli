/**
 * The island's fog on WebGPU: the scene's range fog, and under it a mauve height fog that lies in the valleys and
 * at the foot of the slopes and thins going up, so that the peaks stand out of it (plan I4). It is the scene's
 * `fogNode`: every material that is in the fog takes it, at no cost beyond the fog it already had; the sky and what
 * hangs on it (`fog: false`) stay out. The plaza and the beach (within `HEIGHT_FOG.inner` of the middle) stay clear:
 * they are low, but they are what one looks at, and the logo's inlay must keep its tones. On WebGL the scene keeps the
 * range fog alone.
 */

import { type Fog, type Scene } from "three/webgpu"
import { float, fog, length, max, positionView, positionWorld, rangeFogFactor, smoothstep, uniform } from "three/tsl"

/** Up to this height (metres) the height fog is whole, and it is gone at `HEIGHT_FOG.top`. */
export const HEIGHT_FOG = { floor: 3, top: 24, from: 30, full: 130, strength: 0.5, inner: 34, edge: 12 }

export function heightFog(scene: Scene, rangeFog: Fog): void {
  const color = uniform(rangeFog.color)
  const range = rangeFogFactor(uniform(rangeFog.near), uniform(rangeFog.far))
  const low = float(1).sub(smoothstep(HEIGHT_FOG.floor, HEIGHT_FOG.top, positionWorld.y))
  const away = smoothstep(HEIGHT_FOG.from, HEIGHT_FOG.full, positionView.z.negate())
  const slopes = smoothstep(HEIGHT_FOG.inner, HEIGHT_FOG.inner + HEIGHT_FOG.edge, length(positionWorld.xz))
  const factor = max(range, low.mul(away).mul(slopes).mul(HEIGHT_FOG.strength))
  ;(scene as unknown as { fogNode: unknown }).fogNode = fog(color, factor)
}
