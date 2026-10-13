/**
 * Geometria base. Convenção única do sistema:
 *  - Unidades: mm (inteiros), kg.
 *  - Eixos: Z para cima, mão direita.
 *  - Espaço de carga: origem no canto interno do piso, na parede frontal (oposta à porta),
 *    lado esquerdo olhando para a porta. +X = comprimento (em direção à porta), +Y = largura, +Z = altura.
 *  - Palete: origem no canto frontal-esquerdo da base do palete.
 *  - Posição de qualquer corpo = canto mínimo do seu AABB.
 */

export interface Dims {
  l: number
  w: number
  h: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Qual dimensão do volume (L, W, H) fica nos eixos x, y, z. */
export type Orientation = 'LWH' | 'WLH' | 'LHW' | 'HLW' | 'WHL' | 'HWL'

export const ORIENTATIONS: Orientation[] = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL']
export const UPRIGHT: Orientation[] = ['LWH', 'WLH']

export const ORIENTATION_LABEL: Record<Orientation, string> = {
  LWH: 'Em pé (C×L×A)',
  WLH: 'Em pé girado 90° (L×C×A)',
  LHW: 'Deitado sobre a lateral (C×A×L)',
  HLW: 'Deitado sobre a lateral girado (A×C×L)',
  WHL: 'Apoiado na testa (L×A×C)',
  HWL: 'Apoiado na testa girado (A×L×C)',
}

export function isOrientation(v: unknown): v is Orientation {
  return typeof v === 'string' && (ORIENTATIONS as string[]).includes(v)
}

export function orientDims(d: Dims, o: Orientation): Vec3 {
  const m = { L: d.l, W: d.w, H: d.h } as const
  return { x: m[o[0] as 'L'], y: m[o[1] as 'L'], z: m[o[2] as 'L'] }
}

/** Giro de 90° em torno de Z: troca o que está em x com o que está em y. */
export function yawOrientation(o: Orientation): Orientation {
  return (o[1] + o[0] + o[2]) as Orientation
}

export interface AABB {
  min: Vec3
  size: Vec3
}

export function maxCorner(b: AABB): Vec3 {
  return { x: b.min.x + b.size.x, y: b.min.y + b.size.y, z: b.min.z + b.size.z }
}

export function overlap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Interpenetração estrita (encostar não é colisão). `tol` = interpenetração tolerada em mm. */
export function intersects(a: AABB, b: AABB, tol = 0): boolean {
  const A = maxCorner(a)
  const B = maxCorner(b)
  return (
    overlap1(a.min.x, A.x, b.min.x, B.x) > tol &&
    overlap1(a.min.y, A.y, b.min.y, B.y) > tol &&
    overlap1(a.min.z, A.z, b.min.z, B.z) > tol
  )
}

export function footprintOverlap(a: AABB, b: AABB): number {
  const A = maxCorner(a)
  const B = maxCorner(b)
  return overlap1(a.min.x, A.x, b.min.x, B.x) * overlap1(a.min.y, A.y, b.min.y, B.y)
}

export function volumeMm3(s: Vec3): number {
  return s.x * s.y * s.z
}

/** CBM = L×W×H / 1e9 (mm³ → m³). */
export function cbm(s: Vec3 | Dims): number {
  return 'x' in s ? volumeMm3(s) / 1e9 : (s.l * s.w * s.h) / 1e9
}

export function center(b: AABB): Vec3 {
  return { x: b.min.x + b.size.x / 2, y: b.min.y + b.size.y / 2, z: b.min.z + b.size.z / 2 }
}

export function within(b: AABB, lo: Vec3, hi: Vec3): boolean {
  const M = maxCorner(b)
  return b.min.x >= lo.x && b.min.y >= lo.y && b.min.z >= lo.z && M.x <= hi.x && M.y <= hi.y && M.z <= hi.z
}

export function snap(v: number, step: number): number {
  if (!step || step <= 1) return Math.round(v)
  return Math.round(v / step) * step
}

/** Área da união de retângulos no plano XY (usada para ocupação de piso/superfície). */
export function unionArea(rects: { x0: number; y0: number; x1: number; y1: number }[]): number {
  const valid = rects.filter((r) => r.x1 > r.x0 && r.y1 > r.y0)
  if (valid.length === 0) return 0
  const xs = Array.from(new Set(valid.flatMap((r) => [r.x0, r.x1]))).sort((a, b) => a - b)
  let area = 0
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i]
    const xb = xs[i + 1]
    const spans = valid
      .filter((r) => r.x0 <= xa && r.x1 >= xb)
      .map((r) => [r.y0, r.y1] as [number, number])
      .sort((a, b) => a[0] - b[0])
    let covered = 0
    let cur: [number, number] | null = null
    for (const s of spans) {
      if (!cur || s[0] > cur[1]) {
        if (cur) covered += cur[1] - cur[0]
        cur = [s[0], s[1]]
      } else cur[1] = Math.max(cur[1], s[1])
    }
    if (cur) covered += cur[1] - cur[0]
    area += covered * (xb - xa)
  }
  return area
}

/**
 * Tombar: próxima orientação PERMITIDA em que outra dimensão fica na vertical (H → W → L → H…).
 * Retorna null se o produto só admite ficar em pé (restrição de orientação do cadastro).
 */
export function flipOrientation(o: Orientation, allowed: Orientation[]): Orientation | null {
  const order: ('H' | 'W' | 'L')[] = ['H', 'W', 'L']
  const start = order.indexOf(o[2] as 'H')
  for (let k = 1; k <= 2; k++) {
    const vertical = order[(start + k) % 3]
    // mantém o que estava no comprimento (x) sempre que possível
    const cands = allowed.filter((a) => a[2] === vertical)
    if (cands.length) return cands.find((a) => a[0] === o[0]) ?? cands[0]
  }
  return null
}
