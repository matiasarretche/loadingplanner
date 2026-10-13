/**
 * EDIÇÃO DAS CAIXAS DE UM PALETE DENTRO DA CARGA (modo "dentro do palete" do 3D).
 *
 * Um palete da carga aponta para uma montagem (doc.pallets[key]) que pode ser compartilhada por
 * vários paletes iguais. Antes de editar uma caixa, o palete ganha uma CÓPIA PRÓPRIA (mesma regra
 * dos paletes parciais): os demais não mudam. Coordenadas: as caixas guardam posição LOCAL do
 * palete (x/y a partir do canto, z a partir do topo do tabuleiro); a tela trabalha no espaço da carga.
 */
import { AABB, orientDims, Vec3 } from './geometry'
import { palletPlacement, PalletPlacement } from './load'
import { itemBox } from './pallet'
import type { LoadDoc, LoadUnit, PalletDoc, PalletItem } from './types'

type PalletUnit = Extract<LoadUnit, { kind: 'PALLET' }>

/** Garante que o palete `unitId` tenha montagem própria (copia se for compartilhada). */
export function ownPallet(doc: LoadDoc, unitId: string): { doc: LoadDoc; key: string } | null {
  const u = doc.units.find((x): x is PalletUnit => x.id === unitId && x.kind === 'PALLET')
  if (!u) return null
  const p = doc.pallets[u.palletKey]
  if (!p) return null
  const shared = doc.units.filter((x) => x.kind === 'PALLET' && x.palletKey === u.palletKey).length > 1
  if (!shared) return { doc, key: u.palletKey }
  const base = p.baseKey ?? u.palletKey
  const key = `${base}~${u.id}`
  const copy: PalletDoc = { ...p, baseKey: base, fullBoxes: p.fullBoxes ?? p.items.length }
  return {
    doc: { ...doc, pallets: { ...doc.pallets, [key]: copy }, units: doc.units.map((x) => (x.id === u.id ? { ...u, palletKey: key } : x)) },
    key,
  }
}

/** Aplica uma alteração às caixas do palete `unitId` (com cópia própria se necessário). */
export function editPalletItems(doc: LoadDoc, unitId: string, fn: (p: PalletDoc) => PalletDoc | null): LoadDoc {
  const own = ownPallet(doc, unitId)
  if (!own) return doc
  const p = own.doc.pallets[own.key]
  const next = fn(p)
  if (!next || next === p) return doc
  const used = new Set(next.items.map((i) => i.packId))
  const cleaned: PalletDoc = { ...next, packs: Object.fromEntries(Object.entries(next.packs).filter(([k]) => used.has(k))) }
  return { ...own.doc, pallets: { ...own.doc.pallets, [own.key]: cleaned } }
}

/** Caixa (local do palete) → caixa no espaço da carga. */
export function itemToSpace(p: PalletDoc, unit: { pos: Vec3; yaw: boolean }, it: PalletItem): AABB {
  const pl = palletPlacement(p, unit)
  const b = itemBox(p, it)
  return boxToSpace(pl, p.palletType.dims.h, b)
}

function boxToSpace(pl: PalletPlacement, deckH: number, b: AABB): AABB {
  const { x: lx, y: ly, z: lz } = b.min
  const { x: sx, y: sy, z: sz } = b.size
  const gz = pl.groupPos.z + deckH
  if (pl.rotZ === 0) return { min: { x: pl.groupPos.x + lx, y: pl.groupPos.y + ly, z: gz + lz }, size: { x: sx, y: sy, z: sz } }
  return { min: { x: pl.groupPos.x - ly - sy, y: pl.groupPos.y + lx, z: gz + lz }, size: { x: sy, y: sx, z: sz } }
}

/** Canto mínimo no espaço da carga → posição local da caixa (tamanho local `size`). */
export function spaceToItemPos(p: PalletDoc, unit: { pos: Vec3; yaw: boolean }, worldMin: Vec3, size: Vec3): Vec3 {
  const pl = palletPlacement(p, unit)
  const z = worldMin.z - pl.groupPos.z - p.palletType.dims.h
  if (pl.rotZ === 0) return { x: worldMin.x - pl.groupPos.x, y: worldMin.y - pl.groupPos.y, z }
  return { x: worldMin.y - pl.groupPos.y, y: pl.groupPos.x - worldMin.x - size.y, z }
}

/** Deslocamento no espaço da carga (setas) → deslocamento local do palete (paletes giram só 90°). */
export function spaceDeltaToLocal(unit: { yaw: boolean }, d: Vec3): Vec3 {
  return unit.yaw ? { x: d.y, y: -d.x, z: d.z } : d
}

/** Limites locais para mover caixas no palete: borda do palete (+ overhang) e altura máxima. */
export function palletLocalBounds(p: PalletDoc, maxPalletHeightMm: number): { lo: Vec3; hi: Vec3 } {
  const t = p.palletType
  const oh = t.overhangAllowed ? t.overhangMaxMm : 0
  return { lo: { x: -oh, y: -oh, z: 0 }, hi: { x: t.dims.l + oh, y: t.dims.w + oh, z: Math.max(0, maxPalletHeightMm - t.dims.h) } }
}

/** Obstáculos locais (as outras caixas do palete). */
export function localObstacles(p: PalletDoc, exceptId: string) {
  return p.items.filter((i) => i.id !== exceptId && p.packs[i.packId]).map((i) => ({ box: { min: i.pos, size: orientDims(p.packs[i.packId].dims, i.orientation) }, stackable: true }))
}
