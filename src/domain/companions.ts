/**
 * ACOMPANHANTES OBRIGATÓRIOS (regra de produto): um produto pode exigir outro item junto, em caixa
 * separada — ex.: cada Hydroforce leva 1 kit (mangueira + camlock + torneira). Os kits Hydroforce vão em
 * caixas coletivas (caixa 79583 de 26, meia caixa até 13) ou individuais: ver domain/kitBoxes. Tudo
 * aqui conta KITS (unidades), não caixas.
 *
 * Regra de posição: o acompanhante viaja SEMPRE no MESMO PALETE do produto principal (por cima das
 * caixas dele). Nunca solto no piso, nunca em palete sem o produto principal. Se não couber, o motor
 * AVISA — não coloca em outro lugar.
 *
 * A regra fica no CADASTRO do produto (atributos `acessorio_sku` e `acessorio_qtd` = quantidade por
 * caixa vendida) e chega às cargas pelo snapshot da embalagem (PackSnapshot.companions).
 */
import { addBoxesToMixed, repackKitsOnPallet } from './mixedPallets'
import { kitBaseOf, kitFamilyOf, packKeyOf } from './kitBoxes'
import { physicalChecks } from './checks'
import { effectiveLimits, loadBodies, loadGeometries } from './load'
import type { LoadDoc, PackSnapshot, PalletDoc } from './types'

export interface CompanionRule {
  sku: string
  /** quantidade do acompanhante por caixa do produto principal */
  qty: number
}

/** Lê a regra dos atributos do cadastro (acessorio_sku / acessorio_qtd). */
export function companionsFromAttrs(attrs: Record<string, unknown> | null | undefined): CompanionRule[] {
  const sku = typeof attrs?.acessorio_sku === 'string' ? attrs.acessorio_sku.trim() : ''
  if (!sku) return []
  const q = Number(attrs?.acessorio_qtd ?? 1)
  return [{ sku, qty: Number.isFinite(q) && q > 0 ? q : 1 }]
}

/** Exigido × presente dentro de UM palete (por SKU de acompanhante), em unidades (kits). */
export function palletCompanionNeeds(p: PalletDoc): { sku: string; for: string[]; required: number; present: number }[] {
  const need = new Map<string, { required: number; for: Set<string> }>()
  const have = new Map<string, number>()
  for (const it of p.items) {
    const pack = p.packs[it.packId]
    if (!pack) continue
    // caixa coletiva de kits: conta os kits dentro (unitsPerPackage)
    have.set(pack.sku, (have.get(pack.sku) ?? 0) + pack.unitsPerPackage)
    for (const c of pack.companions ?? []) {
      const cur = need.get(c.sku) ?? { required: 0, for: new Set<string>() }
      cur.required += c.qty
      cur.for.add(pack.sku)
      need.set(c.sku, cur)
    }
  }
  // acompanhantes sem principal neste palete também aparecem (required 0)
  const companionSkus = new Set(need.keys())
  return [...companionSkus].map((sku) => ({ sku, for: [...need.get(sku)!.for].sort(), required: need.get(sku)!.required, present: have.get(sku) ?? 0 }))
}

export interface CompanionStatus {
  sku: string
  /** produtos que exigem este acompanhante */
  for: string[]
  required: number
  /** corretamente no palete do produto principal */
  present: number
  missing: number
  /** acompanhantes fora do lugar: soltos ou em palete sem o produto principal */
  misplaced: number
  /** produtos principais soltos (sem palete): o acompanhante não tem onde ir */
  looseParents: number
}

/** Situação dos acompanhantes na carga: por palete, e os que estão fora do lugar. */
export function companionStatus(doc: LoadDoc, companionSkus?: Set<string>): CompanionStatus[] {
  const out = new Map<string, CompanionStatus & { forSet: Set<string> }>()
  const get = (sku: string) => {
    const cur = out.get(sku) ?? { sku, for: [], forSet: new Set<string>(), required: 0, present: 0, missing: 0, misplaced: 0, looseParents: 0 }
    out.set(sku, cur)
    return cur
  }
  // SKUs que são acompanhantes de algum produto da carga (para achar os soltos / mal colocados)
  const known = new Set(companionSkus ?? [])
  const allPacks = [...Object.values(doc.packs), ...Object.values(doc.pallets).flatMap((p) => Object.values(p.packs))]
  for (const k of allPacks) for (const c of k.companions ?? []) known.add(c.sku)
  for (const g of loadGeometries(doc)) {
    const u = g.unit
    if (u.kind === 'PACKAGE') {
      const pack = doc.packs[u.packId]
      if (!pack) continue
      if (known.has(pack.sku)) get(pack.sku).misplaced += pack.unitsPerPackage
      for (const c of pack.companions ?? []) {
        const s = get(c.sku)
        s.required += c.qty
        s.missing += c.qty
        s.looseParents++
        s.forSet.add(pack.sku)
      }
      continue
    }
    const p = doc.pallets[u.palletKey]
    if (!p) continue
    const needs = palletCompanionNeeds(p)
    const neededSkus = new Set(needs.map((n) => n.sku))
    for (const n of needs) {
      const s = get(n.sku)
      s.required += n.required
      s.present += Math.min(n.present, n.required)
      s.missing += Math.max(0, n.required - n.present)
      n.for.forEach((f) => s.forSet.add(f))
    }
    // acompanhantes num palete que não tem o principal
    for (const it of p.items) {
      const k = p.packs[it.packId]
      if (k && known.has(k.sku) && !neededSkus.has(k.sku)) get(k.sku).misplaced += k.unitsPerPackage
    }
  }
  return [...out.values()].map(({ forSet, ...s }) => ({ ...s, for: [...forSet].sort() }))
}

type FindPack = (sku: string) => { packId: string; pack: PackSnapshot } | null
type Added = { sku: string; placed: number; missing: number; reason?: string }

/**
 * Completa os acompanhantes que faltam num PALETE (por cima, até a altura máxima), sem olhar a carga.
 * Kits com caixas coletivas (KIT-HF): reembala todos os kits do palete pela regra (26 / meia caixa /
 * individuais) — só troca se couberem mais kits que antes. Palete já completo não muda.
 */
export function completePalletCompanions(p0: PalletDoc, findPack: FindPack, maxPalletHeightMm: number): { doc: PalletDoc; added: Added[] } {
  let p = p0
  const added: Added[] = []
  const short = 'sem espaço/altura por cima do palete do produto principal'
  for (const n of palletCompanionNeeds(p0)) {
    const miss = n.required - n.present
    if (miss <= 0) continue
    const k = findPack(n.sku)
    if (!k) {
      added.push({ sku: n.sku, placed: 0, missing: miss, reason: 'acompanhante não cadastrado no catálogo' })
      continue
    }
    if (kitFamilyOf(n.sku)) {
      const base = kitBaseOf(k.pack)
      const r = repackKitsOnPallet(p, base, k.pack.kitBox ? packKeyOf(base) : k.packId, Math.ceil(n.required - 1e-9), maxPalletHeightMm)
      const placed = Math.max(0, r.placed - n.present)
      if (placed > 0) p = r.doc
      added.push({ sku: n.sku, placed, missing: miss - placed, ...(placed < miss ? { reason: short } : {}) })
      continue
    }
    const r = addBoxesToMixed(p, k.packId, k.pack, miss, maxPalletHeightMm)
    p = r.doc
    added.push({ sku: n.sku, placed: r.added, missing: miss - r.added, ...(r.added < miss ? { reason: short } : {}) })
  }
  return { doc: p, added }
}

/**
 * Completa os acompanhantes que faltam DENTRO dos paletes que contêm o produto principal (por cima,
 * até a altura máxima; kits em caixas coletivas pela regra). Se não couber — ou se a nova altura colidir
 * com algo por cima do palete na carga — NÃO coloca em outro lugar: devolve o que ficou faltando para o aviso.
 */
export function addMissingCompanions(doc: LoadDoc, findPack: FindPack, maxPalletHeightMm: number = palletHeightLimit(doc)): { doc: LoadDoc; added: Added[] } {
  let d = doc
  const tally = new Map<string, { placed: number; missing: number; reason?: string }>()
  const bump = (sku: string, placed: number, missing: number, reason?: string) => {
    const cur = tally.get(sku) ?? { placed: 0, missing: 0 }
    cur.placed += placed
    cur.missing += missing
    if (reason) cur.reason = reason
    tally.set(sku, cur)
  }
  const keys = [...new Set(d.units.flatMap((u) => (u.kind === 'PALLET' ? [u.palletKey] : [])))]
  for (const key of keys) {
    const p0 = d.pallets[key]
    if (!p0) continue
    const unitsOfKey = d.units.filter((u) => u.kind === 'PALLET' && u.palletKey === key).length
    const c = completePalletCompanions(p0, findPack, maxPalletHeightMm)
    const p = c.doc
    for (const a of c.added) bump(a.sku, a.placed * unitsOfKey, a.missing * unitsOfKey, a.reason)
    if (p === p0) continue
    // o palete ficou mais alto: só aceita se não criar colisão/apoio/altura na carga
    const trial: LoadDoc = { ...d, pallets: { ...d.pallets, [key]: p } }
    const before = physicalChecks(loadBodies(d), { floorZ: 0, collisionTolMm: 0, minSupportPct: 70 }).issues.filter((i) => i.severity === 'CRITICAL').length
    const after = physicalChecks(loadBodies(trial), { floorZ: 0, collisionTolMm: 0, minSupportPct: 70 }).issues.filter((i) => i.severity === 'CRITICAL').length
    if (after > before) {
      for (const n of palletCompanionNeeds(p0)) {
        const miss = n.required - n.present
        if (miss > 0) {
          const cur = tally.get(n.sku)!
          cur.missing += cur.placed
          cur.placed = 0
          cur.reason = 'o palete com os kits colidiria com a carga por cima dele'
        }
      }
      continue
    }
    d = trial
  }
  return { doc: d, added: [...tally.entries()].map(([sku, t]) => ({ sku, ...t })) }
}

/** Altura máxima de um palete carregado nesta carga: porta, altura interna e limite dos perfis. */
export function palletHeightLimit(doc: LoadDoc): number {
  return Math.min(doc.space.door.h, doc.space.inner.h, effectiveLimits(doc).heightMm.value ?? Infinity)
}

/**
 * Acompanhantes de um pedido, em KITS (unidades) = caixas do principal × quantidade. As caixas de kits
 * (26 / meia caixa / individuais) saem da montagem dos paletes (ou de kitOrderLines, sem palete).
 */
export function companionLines<T extends { pack: PackSnapshot; boxes: number }>(order: T[]): { sku: string; kits: number; for: string[] }[] {
  const m = new Map<string, { kits: number; for: Set<string> }>()
  for (const o of order)
    for (const c of o.pack.companions ?? []) {
      const cur = m.get(c.sku) ?? { kits: 0, for: new Set<string>() }
      cur.kits += Math.ceil(o.boxes * c.qty)
      cur.for.add(o.pack.sku)
      m.set(c.sku, cur)
    }
  return [...m.entries()].map(([sku, v]) => ({ sku, kits: v.kits, for: [...v.for] }))
}
