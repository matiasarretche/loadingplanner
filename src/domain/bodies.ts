import { AABB, footprintOverlap, intersects, maxCorner } from './geometry'

/**
 * Corpo físico genérico: item dentro de palete, unidade dentro do contêiner/veículo,
 * ou PARTE de um palete na carga (tabuleiro ou caixa), agrupada pela unidade.
 */
export interface Body {
  id: string
  label: string
  box: AABB
  kg: number
  /** Aceita carga por cima? */
  stackable: boolean
  /** Peso máximo aceito por cima (kg); null = sem limite informado. */
  maxTopKg: number | null
  /** Máximo de camadas empilhadas deste mesmo item (inclui ele mesmo); null = sem limite. */
  maxStackLayers?: number | null
  /** Chave de agrupamento para contar camadas do mesmo produto. */
  stackKey?: string
  /**
   * Grupo físico (ex.: todas as partes de um palete). Corpos do mesmo grupo não colidem nem se apoiam
   * entre si aqui (o interior do palete é validado na montagem). Padrão: o próprio id.
   */
  group?: string
  groupLabel?: string
  /** false = não verificar apoio deste corpo (caixas internas de um palete) */
  checkSupport?: boolean
  /** carga externa recebida por este corpo é transmitida a outro corpo (caixa do palete → base do palete) */
  transferTo?: string
  /** papel do corpo, para a regra de empilhamento */
  role?: 'box' | 'pallet-base' | 'pallet-item'
  /** para partes de palete: o palete aceita OUTRO PALETE por cima? */
  palletStackable?: boolean
}

/** Tolerância (mm) para considerar que o topo de um corpo toca a base do outro. */
export const CONTACT_TOL_MM = 1

const groupOf = (b: Body) => b.group ?? b.id

/**
 * Pode `lower` sustentar `upper`?
 * - palete sobre palete: depende de o palete de baixo aceitar paletes por cima;
 * - caixa sobre caixa (solta ou do topo de um palete): depende da caixa de baixo ser empilhável;
 * - caixa sobre o tabuleiro vazio de um palete parcial: permitido.
 */
export function canSupport(lower: Body, upper: Body): boolean {
  if (upper.role === 'pallet-base' && (lower.role === 'pallet-item' || lower.role === 'pallet-base')) return Boolean(lower.palletStackable)
  if (lower.role === 'pallet-base') return true
  return lower.stackable
}

/** Pares de corpos que se interpenetram (corpos do mesmo grupo são ignorados). */
export function findCollisions(bodies: Body[], tol = 0): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      if (groupOf(bodies[i]) === groupOf(bodies[j])) continue
      if (intersects(bodies[i].box, bodies[j].box, tol)) out.push([bodies[i].id, bodies[j].id])
    }
  return out
}

export interface SupportInfo {
  /** % da área da base apoiada (piso ou topo de outros corpos) */
  supportedPct: number
  onFloor: boolean
  supporters: { id: string; area: number }[]
}

export function computeSupport(bodies: Body[], floorZ = 0): Map<string, SupportInfo> {
  const res = new Map<string, SupportInfo>()
  for (const b of bodies) {
    if (b.checkSupport === false) continue
    const base = b.box.size.x * b.box.size.y
    if (Math.abs(b.box.min.z - floorZ) <= CONTACT_TOL_MM) {
      res.set(b.id, { supportedPct: 100, onFloor: true, supporters: [] })
      continue
    }
    const supporters: { id: string; area: number }[] = []
    for (const o of bodies) {
      if (o.id === b.id || groupOf(o) === groupOf(b)) continue
      const top = maxCorner(o.box).z
      if (Math.abs(top - b.box.min.z) > CONTACT_TOL_MM) continue
      const area = footprintOverlap(b.box, o.box)
      if (area > 0) supporters.push({ id: o.id, area })
    }
    // áreas de apoiadores diferentes não se sobrepõem se não houver colisão entre eles
    const supported = Math.min(base, supporters.reduce((s, x) => s + x.area, 0))
    res.set(b.id, { supportedPct: base > 0 ? (supported / base) * 100 : 0, onFloor: false, supporters })
  }
  return res
}

/**
 * Peso (kg) apoiado sobre cada corpo, somando recursivamente o que está em cima,
 * dividido entre apoiadores proporcionalmente à área de contato. A carga recebida pelas
 * caixas de um palete desce para a base do palete (transferTo) e dali para o que estiver embaixo.
 */
export function computeTopLoads(bodies: Body[], support: Map<string, SupportInfo>): Map<string, number> {
  const byId = new Map(bodies.map((b) => [b.id, b]))
  const load = new Map<string, number>(bodies.map((b) => [b.id, 0]))
  const sorted = [...bodies].sort((a, b) => b.box.min.z - a.box.min.z) // de cima para baixo
  for (const b of sorted) {
    if (b.transferTo && byId.has(b.transferTo)) {
      load.set(b.transferTo, (load.get(b.transferTo) ?? 0) + (load.get(b.id) ?? 0) + b.kg)
      continue
    }
    const s = support.get(b.id)
    if (!s || s.onFloor || s.supporters.length === 0) continue
    const total = s.supporters.reduce((t, x) => t + x.area, 0)
    const carried = b.kg + (load.get(b.id) ?? 0)
    for (const sup of s.supporters) {
      if (!byId.has(sup.id)) continue
      load.set(sup.id, (load.get(sup.id) ?? 0) + carried * (sup.area / total))
    }
  }
  return load
}

/** Número de camadas da mesma chave (produto) empilhadas até este corpo, contando ele. */
export function computeStackDepth(bodies: Body[], support: Map<string, SupportInfo>): Map<string, number> {
  const byId = new Map(bodies.map((b) => [b.id, b]))
  const depth = new Map<string, number>()
  const sorted = [...bodies].sort((a, b) => a.box.min.z - b.box.min.z) // de baixo para cima
  for (const b of sorted) {
    const s = support.get(b.id)
    let d = 1
    if (s && !s.onFloor) {
      for (const sup of s.supporters) {
        const o = byId.get(sup.id)
        if (o && o.stackKey && o.stackKey === b.stackKey) d = Math.max(d, (depth.get(o.id) ?? 1) + 1)
      }
    }
    depth.set(b.id, d)
  }
  return depth
}
