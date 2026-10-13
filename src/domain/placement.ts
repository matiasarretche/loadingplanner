import { AABB, footprintOverlap, intersects, maxCorner, Vec3 } from './geometry'

export interface Obstacle {
  box: AABB
  stackable: boolean
}

export interface FreePositionOptions {
  lo: Vec3
  hi: Vec3
  /** Permitir posicionar sobre outros corpos empilháveis */
  allowStacking: boolean
  minSupportPct: number
  /** posições candidatas a mais (ex.: grade das caixas de kits centralizada no palete) */
  extra?: Vec3[]
}

/**
 * Ajuda para edição manual (não é o otimizador): encontra a primeira posição livre
 * por "pontos extremos", preenchendo do fundo (x=0) para a porta, piso primeiro.
 */
export function findFreePosition(obstacles: Obstacle[], size: Vec3, o: FreePositionOptions): Vec3 | null {
  const cands: Vec3[] = [{ ...o.lo }]
  for (const ob of obstacles) {
    const M = maxCorner(ob.box)
    cands.push({ x: M.x, y: ob.box.min.y, z: ob.box.min.z })
    cands.push({ x: ob.box.min.x, y: M.y, z: ob.box.min.z })
    cands.push({ x: M.x, y: o.lo.y, z: o.lo.z })
    cands.push({ x: o.lo.x, y: M.y, z: o.lo.z })
    if (o.allowStacking && ob.stackable) cands.push({ x: ob.box.min.x, y: ob.box.min.y, z: M.z })
  }
  if (o.extra) cands.push(...o.extra)
  cands.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y)
  for (const c of cands) {
    const box: AABB = { min: c, size }
    const M = maxCorner(box)
    if (c.x < o.lo.x || c.y < o.lo.y || c.z < o.lo.z || M.x > o.hi.x || M.y > o.hi.y || M.z > o.hi.z) continue
    if (obstacles.some((ob) => intersects(box, ob.box))) continue
    if (c.z > o.lo.z) {
      const base = size.x * size.y
      let sup = 0
      let ok = true
      for (const ob of obstacles) {
        if (maxCorner(ob.box).z !== c.z) continue
        const a = footprintOverlap(box, ob.box)
        if (a > 0 && !ob.stackable) ok = false
        sup += a
      }
      if (!ok || (sup / base) * 100 < o.minSupportPct) continue
    }
    return c
  }
  return null
}

/**
 * Validação de uma posição escolhida à mão (soltar um arrasto no 3D): limites, altura máxima,
 * colisão, apoio mínimo e base empilhável. Devolve o motivo (texto para o usuário) ou null se vale.
 * Tolerância de 1 mm para contato face a face.
 */
export function placementProblem(obstacles: Obstacle[], box: AABB, o: { lo: Vec3; hi: Vec3; minSupportPct: number }): string | null {
  const M = maxCorner(box)
  const t = 1
  if (box.min.x < o.lo.x - t || box.min.y < o.lo.y - t || M.x > o.hi.x + t || M.y > o.hi.y + t) return 'fora dos limites do espaço'
  if (box.min.z < o.lo.z - t) return 'abaixo do piso'
  if (M.z > o.hi.z + t) return 'acima da altura máxima'
  if (obstacles.some((ob) => intersects(box, ob.box, t))) return 'atravessa outro volume'
  if (box.min.z > o.lo.z + t) {
    let sup = 0
    for (const ob of obstacles) {
      if (Math.abs(maxCorner(ob.box).z - box.min.z) > t) continue
      const a = footprintOverlap(box, ob.box)
      if (a > 0 && !ob.stackable) return 'apoiado sobre um volume que não aceita peso em cima'
      sup += a
    }
    const pct = (sup / (box.size.x * box.size.y)) * 100
    if (pct <= 0) return 'ficaria flutuando (sem apoio embaixo)'
    if (pct < o.minSupportPct) return `apoio insuficiente (${Math.round(pct)}% da base; mínimo ${o.minSupportPct}%)`
  }
  return null
}

/** Altura de repouso ao arrastar: o corpo assenta na superfície mais alta sob a sua base (ou no piso). */
export function restZ(obstacles: Obstacle[], box: AABB, floorZ = 0): number {
  // margem de 2 mm: encostar lado a lado (ou erro de passo) não faz o corpo "subir" no vizinho
  const m = 2
  const core: AABB = { min: { x: box.min.x + m, y: box.min.y + m, z: box.min.z }, size: { x: Math.max(0, box.size.x - 2 * m), y: Math.max(0, box.size.y - 2 * m), z: box.size.z } }
  let z = floorZ
  for (const ob of obstacles) if (footprintOverlap(core, ob.box) > 0) z = Math.max(z, maxCorner(ob.box).z)
  return z
}

/** Desce o corpo até o primeiro apoio (piso ou topo de outro corpo abaixo). */
export function dropZ(obstacles: Obstacle[], box: AABB, floorZ = 0): number {
  let z = floorZ
  for (const ob of obstacles) {
    const top = maxCorner(ob.box).z
    if (top <= box.min.z + 1 && footprintOverlap(box, ob.box) > 0) z = Math.max(z, top)
  }
  return z
}
