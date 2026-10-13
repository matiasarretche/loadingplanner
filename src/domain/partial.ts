/**
 * Paletes parciais: retirar caixas de UM palete já colocado na carga.
 * Paletes iguais compartilham a mesma montagem (doc.pallets[key]); ao retirar caixas, o palete
 * afetado ganha uma cópia própria ("parcial"), com referência à origem e à quantidade completa.
 * Kits em caixas coletivas (KIT-HF): ficam 1 por caixa do produto que sobrou, reembalados pela regra
 * sobre o que ficou (ex.: tirar 10 HF de um palete de 36 → 26 HF + 1 caixa de 26 kits). Nunca ficam
 * caixas de kits sem apoio: o que não couber fica faltando (alerta COMPANION_MISSING).
 */
import { physicalChecks } from './checks'
import { palletCompanionNeeds, palletHeightLimit } from './companions'
import { kitBaseOf, kitFamilyOf, packKeyOf } from './kitBoxes'
import { loadBodies } from './load'
import { repackKitsOnPallet } from './mixedPallets'
import { palletSummary } from './pallet'
import type { LoadDoc, PalletDoc } from './types'

export interface RemoveBoxesResult {
  doc: LoadDoc
  removed: number
  remaining: number
  error?: string
}

/**
 * Caixas de cima para baixo (e do fundo para a frente): ordem natural de retirada. Sem SKU, as caixas
 * de kits não contam (seguem o produto: são reembaladas depois).
 */
function removalOrder(p: PalletDoc, sku?: string) {
  return p.items
    .filter((it) => !it.locked && (sku ? p.packs[it.packId]?.sku.toUpperCase() === sku.toUpperCase() : !kitFamilyOf(p.packs[it.packId]?.sku ?? '')))
    .sort((a, b) => b.pos.z - a.pos.z || b.pos.x - a.pos.x || b.pos.y - a.pos.y)
}

export function removeBoxesFromPallet(doc: LoadDoc, unitId: string, count: number, sku?: string): RemoveBoxesResult {
  const u = doc.units.find((x) => x.id === unitId)
  if (!u || u.kind !== 'PALLET') return { doc, removed: 0, remaining: 0, error: 'Unidade não é um palete.' }
  if (u.locked) return { doc, removed: 0, remaining: 0, error: 'Palete travado.' }
  const p = doc.pallets[u.palletKey]
  if (!p) return { doc, removed: 0, remaining: 0, error: 'Montagem do palete não encontrada.' }
  const order = removalOrder(p, sku)
  if (!order.length) return { doc, removed: 0, remaining: p.items.length, error: sku ? `O palete não tem caixas de ${sku}.` : 'O palete não tem caixas removíveis.' }
  const n = Math.max(0, Math.min(Math.floor(count), order.length))
  const drop = new Set(order.slice(0, n).map((it) => it.id))
  const items = p.items.filter((it) => !drop.has(it.id))
  const baseKey = p.baseKey ?? u.palletKey
  const ownKey = `${baseKey}~${u.id}`
  const usedPacks = new Set(items.map((i) => i.packId))
  let partial: PalletDoc = {
    ...p,
    name: p.baseKey ? p.name : `${p.name} (parcial)`,
    items,
    packs: Object.fromEntries(Object.entries(p.packs).filter(([k]) => usedPacks.has(k) || !items.length)),
    baseKey,
    fullBoxes: p.fullBoxes ?? p.items.length,
  }
  const units = doc.units.map((x) => (x.id === u.id ? { ...u, palletKey: ownKey } : x))
  const used = new Set(units.flatMap((x) => (x.kind === 'PALLET' ? [x.palletKey] : [])))
  const withPallet = (q: PalletDoc): LoadDoc => ({ ...doc, units, pallets: Object.fromEntries(Object.entries({ ...doc.pallets, [ownKey]: q }).filter(([k]) => used.has(k))) })
  // kits (1 por caixa do produto que ficou): as caixas de kits são refeitas sobre o que ficou — as caixas
  // retiradas podiam ser as que as apoiavam (ex.: HF de cima de um palete de 52 HF 2K sob as caixas de 26).
  // Até a altura máxima da carga; mais alto que antes só se não colidir com o que está por cima na carga.
  const oldH = palletSummary(p).totalHeightMm
  const repack = (q0: PalletDoc, maxH: number) => {
    let q = q0
    const needs = new Map(palletCompanionNeeds(q).map((x) => [x.sku, x.required]))
    const kitPacks = new Map(Object.values(q.packs).filter((x) => kitFamilyOf(x.sku)).map((x) => [x.sku, x]))
    for (const [kitSku, k] of kitPacks) {
      const required = Math.ceil((needs.get(kitSku) ?? 0) - 1e-9)
      const present = q.items.reduce((t, it) => t + (q.packs[it.packId]?.sku === kitSku ? q.packs[it.packId].unitsPerPackage : 0), 0)
      if (!present) continue
      const base = kitBaseOf(k)
      // nunca mais kits que antes (faltantes: "Colocar por cima"); os que não couberem ficam faltando
      q = repackKitsOnPallet(q, base, packKeyOf(base), Math.min(required, present), maxH).doc
    }
    return q
  }
  if (n > 0 && items.length) {
    const limit = Math.max(palletHeightLimit(doc), oldH)
    let q = repack(partial, limit)
    if (palletSummary(q).totalHeightMm > oldH + 0.5) {
      const crit = (d: LoadDoc) => physicalChecks(loadBodies(d), { floorZ: 0, collisionTolMm: 0, minSupportPct: 70 }).issues.filter((i) => i.severity === 'CRITICAL').length
      const low = repack(partial, oldH)
      if (crit(withPallet(q)) > crit(withPallet(low))) q = low
    }
    partial = q
  }
  if (!partial.items.length) partial = { ...partial, packs: p.packs }
  return { doc: withPallet(partial), removed: n, remaining: partial.items.length }
}

export function palletBoxCounts(p: PalletDoc): { boxes: number; fullBoxes: number; partial: boolean } {
  const full = p.fullBoxes ?? p.items.length
  return { boxes: p.items.length, fullBoxes: full, partial: p.items.length < full }
}
