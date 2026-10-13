/**
 * ORIENTAÇÃO DAS CAIXAS — lógica única para edição manual (girar/tombar) e otimizadores.
 *
 * As 6 permutações de C×L×A (LWH, WLH, LHW, HLW, WHL, HWL) dizem qual dimensão da caixa fica em
 * x, y e z. Se duas dimensões são iguais, algumas permutações são equivalentes e são tratadas como uma só.
 *
 * O cadastro guarda as orientações PERMITIDAS por produto (allowedOrientations). Políticas prontas:
 *  - ANY     → livre (as 6; padrão)
 *  - UPRIGHT → manter em pé (só LWH / WLH — "não pode deitar")
 *  - lista personalizada (ex.: só deitada de lado)
 * Os otimizadores usam, entre as permitidas, só as ESTÁVEIS (altura ≤ STABLE_RATIO × menor lado da base).
 */
import { AABB, Dims, intersects, maxCorner, ORIENTATIONS, Orientation, orientDims, Vec3 } from './geometry'
import { dropZ, findFreePosition, Obstacle } from './placement'

export type OrientationPolicy = 'ANY' | 'UPRIGHT' | 'CUSTOM'

export const ORIENTATION_POLICIES: Record<Exclude<OrientationPolicy, 'CUSTOM'>, Orientation[]> = {
  ANY: [...ORIENTATIONS],
  UPRIGHT: ['LWH', 'WLH'],
}

export const POLICY_LABEL: Record<OrientationPolicy, string> = {
  ANY: 'Livre (todas as faces)',
  UPRIGHT: 'Manter em pé (não deitar)',
  CUSTOM: 'Somente as orientações marcadas',
}

/** Padrão para produtos novos: livre. */
export const DEFAULT_ORIENTATIONS: Orientation[] = ORIENTATION_POLICIES.ANY

export function policyOf(allowed: Orientation[]): OrientationPolicy {
  const set = new Set(allowed)
  if (ORIENTATIONS.every((o) => set.has(o))) return 'ANY'
  if (set.size === 2 && set.has('LWH') && set.has('WLH')) return 'UPRIGHT'
  return 'CUSTOM'
}

const key = (v: Vec3) => `${v.x}x${v.y}x${v.z}`

/** Orientações permitidas sem repetir as equivalentes (mesmas dimensões ocupadas em x/y/z). */
export function distinctOrientations(dims: Dims, allowed: Orientation[] = ORIENTATIONS): Orientation[] {
  const seen = new Set<string>()
  const out: Orientation[] = []
  for (const o of ORIENTATIONS) {
    if (!allowed.includes(o)) continue
    const k = key(orientDims(dims, o))
    if (seen.has(k)) continue
    seen.add(k)
    out.push(o)
  }
  return out
}

/** Razão máxima altura / menor lado da base aceita pelos otimizadores (evita caixa "em pé no canto"). */
export const STABLE_RATIO = 2

export function isStable(dims: Dims, o: Orientation, ratio = STABLE_RATIO): boolean {
  const d = orientDims(dims, o)
  return d.z <= ratio * Math.min(d.x, d.y)
}

/**
 * Orientações por ordem NATURAL de transporte: menor altura primeiro (apoiada na maior face) e, com a
 * mesma altura, maior área de apoio; empate: como cadastrado (LWH antes). Só entre as permitidas.
 */
export function naturalOrientations(dims: Dims, allowed: Orientation[] = ORIENTATIONS): Orientation[] {
  return distinctOrientations(dims, allowed).sort((a, b) => {
    const da = orientDims(dims, a), db = orientDims(dims, b)
    return da.z - db.z || db.x * db.y - da.x * da.y || ORIENTATIONS.indexOf(a) - ORIENTATIONS.indexOf(b)
  })
}

/** Orientação inicial/padrão de uma caixa (a mais estável permitida). */
export function defaultOrientation(dims: Dims, allowed: Orientation[]): Orientation {
  return naturalOrientations(dims, allowed)[0] ?? allowed[0] ?? 'LWH'
}

/**
 * Orientações que o motor automático usa: só a(s) da face NATURAL (menor altura permitida), com as
 * variantes giradas em z. Restrição do produto (ex.: só em pé) prevalece, pois filtra antes.
 * Tombar/deitar continua possível na edição manual.
 */
export function autoOrientations(dims: Dims, allowed: Orientation[]): Orientation[] {
  const nat = naturalOrientations(dims, allowed)
  if (!nat.length) return [allowed[0] ?? 'LWH']
  const z0 = orientDims(dims, nat[0]).z
  return nat.filter((o) => orientDims(dims, o).z === z0)
}

/** Grupos por face apoiada (qual dimensão fica na vertical), com as variantes giradas em z. */
export function orientationsByVertical(dims: Dims, allowed: Orientation[]): Map<'L' | 'W' | 'H', Orientation[]> {
  const m = new Map<'L' | 'W' | 'H', Orientation[]>()
  for (const o of distinctOrientations(dims, allowed)) {
    const v = o[2] as 'L' | 'W' | 'H'
    m.set(v, [...(m.get(v) ?? []), o])
  }
  return m
}

/**
 * TOMBAR: próxima face na vertical (H → W → L → H…), entre as permitidas e com dimensões diferentes
 * da atual; mantém o que estava no comprimento (x) sempre que possível. null se não houver outra.
 */
export function nextFlip(current: Orientation, dims: Dims, allowed: Orientation[]): Orientation | null {
  const order: ('H' | 'W' | 'L')[] = ['H', 'W', 'L']
  const now = orientDims(dims, current)
  const start = order.indexOf(current[2] as 'H')
  // só faces com OUTRA dimensão na vertical (girar em z é nextYaw)
  for (let k = 1; k <= 2; k++) {
    const vertical = order[(start + k) % 3]
    const cands = distinctOrientations(dims, allowed).filter((a) => a[2] === vertical && key(orientDims(dims, a)) !== key(now))
    if (cands.length) return cands.find((a) => a[0] === current[0]) ?? cands[0]
  }
  return null
}

/** GIRAR 90° em z: troca x ↔ y (se a orientação resultante for permitida e diferente). */
export function nextYaw(current: Orientation, dims: Dims, allowed: Orientation[]): Orientation | null {
  const o = (current[1] + current[0] + current[2]) as Orientation
  if (!allowed.includes(o)) return null
  return key(orientDims(dims, o)) === key(orientDims(dims, current)) ? null : o
}

/**
 * Reposiciona uma caixa depois de mudar a orientação: mantém o CENTRO em x/y, ajusta para dentro
 * dos limites, apoia (desce até o piso/caixa de baixo) e, se colidir, procura a posição livre mais
 * próxima. Devolve a nova posição (canto mínimo) ou null se não houver lugar.
 */
export function reorientPosition(old: AABB, newSize: Vec3, obstacles: Obstacle[], bounds: { lo: Vec3; hi: Vec3 }, minSupportPct = 70): Vec3 | null {
  const cx = old.min.x + old.size.x / 2, cy = old.min.y + old.size.y / 2
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  const x = Math.round(clamp(cx - newSize.x / 2, bounds.lo.x, bounds.hi.x - newSize.x))
  const y = Math.round(clamp(cy - newSize.y / 2, bounds.lo.y, bounds.hi.y - newSize.y))
  const probe: AABB = { min: { x, y, z: old.min.z }, size: newSize }
  const z = dropZ(obstacles, probe, bounds.lo.z)
  const box: AABB = { min: { x, y, z }, size: newSize }
  const M = maxCorner(box)
  const inside = M.x <= bounds.hi.x && M.y <= bounds.hi.y && M.z <= bounds.hi.z
  if (inside && !obstacles.some((o) => intersects(box, o.box))) return box.min
  return findFreePosition(obstacles, newSize, { lo: bounds.lo, hi: bounds.hi, allowStacking: true, minSupportPct })
}
