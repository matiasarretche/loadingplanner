// Sem 'server-only': também é usado pelo script de linha de comando.
import { and, eq } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { buildReferencePallet } from '@/domain/autopallet'
import { countBySeverity } from '@/domain/issues'
import { describeKitBoxes, kitBoxLines, kitFamilyOf } from '@/domain/kitBoxes'
import { REFERENCE_PALLET_HC_HEIGHT_MM, REFERENCE_PALLET_MAX_HEIGHT_MM } from '@/domain/logisticsRules'
import { optimizeMixedPallets } from '@/domain/mixedPallets'
import { palletSummary, validatePallet } from '@/domain/pallet'
import type { PackSnapshot, PalletDoc, PalletTypeSnapshot } from '@/domain/types'
import { packSnapshot, palletTypeSnapshot } from './snapshots'

export interface GenerationResult {
  created: number
  skipped: number
  refreshed: number
  lines: string[]
}

/** JSON com chaves ordenadas (o jsonb do PostgreSQL reordena as chaves). */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/** Excesso aceito sobre o palete para ganhar volumes por camada (marcado como OVERHANG na validação). */
const TOLERANCE_MM = 25

function notesFor(sku: string, version: number, n: number, ref: ReturnType<typeof buildReferencePallet>) {
  return (
    `Gerada automaticamente a partir da embalagem ${sku} v${version} (${n} un./palete). ` +
    `Padrão "${ref.pattern.name}": ${ref.perLayer} por camada × ${ref.layers} camada(s). ` +
    'VALIDAR antes de usar em carga real.'
  )
}

/**
 * Para cada embalagem vigente com "unidades por palete" e palete padrão, cria a montagem
 * "REF · <SKU> · <N> u" (se ainda não existir ativa). As montagens ficam para validação manual.
 * refreshUnedited: recalcula montagens REF já geradas que ninguém editou depois.
 */
/**
 * Montagem de referência de um produto COM ACOMPANHANTE obrigatório (ex.: Hydroforce + kits):
 * montada pelo otimizador de paletes (mesma lógica de camadas/orientação), com os kits por cima em
 * caixas coletivas (domain/kitBoxes). O palete padrão do catálogo prevalece: EXATAMENTE `upp` caixas,
 * até REFERENCE_PALLET_MAX_HEIGHT_MM (porta do 20'/40' Dry) ou, se os kits não deixarem, até a porta do
 * 40' HC (hcOnly). Só se nem assim couber, o maior número de caixas que cabe (avisado nas notas).
 */
export function companionReference(
  pt: PalletTypeSnapshot,
  pack: PackSnapshot,
  packId: string,
  upp: number,
  kit: { packId: string; pack: PackSnapshot; qty: number },
): { doc: PalletDoc; n: number; heightMm: number; hcOnly: boolean } | null {
  const one = (n: number, maxHeightMm: number) => {
    const r = optimizeMixedPallets(
      [
        { packId, pack, boxes: n },
        { packId: kit.packId, pack: kit.pack, boxes: Math.ceil(n * kit.qty) },
      ],
      { palletTypes: [pt], maxHeightMm },
    )
    const p = r.ok && r.pallets.length === 1 ? r.pallets[0] : null
    return p ? { doc: p.doc, n, heightMm: Math.round(p.heightMm), hcOnly: p.heightMm > REFERENCE_PALLET_MAX_HEIGHT_MM } : null
  }
  for (const h of [REFERENCE_PALLET_MAX_HEIGHT_MM, REFERENCE_PALLET_HC_HEIGHT_MM]) {
    const r = one(upp, h)
    if (r) return r
  }
  for (let n = upp - 1; n >= 1; n--) {
    const r = one(n, REFERENCE_PALLET_HC_HEIGHT_MM)
    if (r) return r
  }
  return null
}

/** Notas da REF com acompanhante: kits por cima (caixas por tipo), altura e "só 40' HC / rodoviário" quando passa de 2.292 mm. */
export function companionNotes(sku: string, version: number, upp: number, cr: { doc: PalletDoc; n: number; heightMm: number; hcOnly: boolean }, kitSku: string): string {
  const kitPacks = cr.doc.items.map((it) => cr.doc.packs[it.packId]).filter((k) => k?.sku === kitSku)
  const kits = kitPacks.reduce((s, k) => s + k.unitsPerPackage, 0)
  const boxes = kitFamilyOf(kitSku) && kitPacks.length ? ` (${describeKitBoxes(kitBoxLines(kitPacks))})` : ''
  const h = cr.heightMm.toLocaleString('pt-BR')
  return (
    `Gerada automaticamente a partir da embalagem ${sku} v${version}: ${cr.n} un. + ${kits} ${kitSku} por cima${boxes} (acompanhante obrigatório), ` +
    (cr.hcOnly ? `altura ${h} mm: só 40' HC / rodoviário` : `altura total ${h} mm (≤ ${REFERENCE_PALLET_MAX_HEIGHT_MM.toLocaleString('pt-BR')} mm)`) +
    (cr.n < upp ? `; as ${upp} un. do catálogo não couberam com os kits nem no 40' HC` : '') +
    '. VALIDAR antes de usar em carga real.'
  )
}

/** Embalagem vigente de um SKU (para achar o acompanhante). */
export async function latestPackBySku(sku: string): Promise<{ packId: string; pack: PackSnapshot } | null> {
  const rows = await db.select({ pv: s.packagingVersions, v: s.productVariants }).from(s.packagingVersions).innerJoin(s.productVariants, eq(s.productVariants.id, s.packagingVersions.variantId)).where(eq(s.productVariants.sku, sku))
  const best = rows.filter((r) => r.v.active).sort((a, b) => b.pv.version - a.pv.version)[0]
  return best ? { packId: `pv${best.pv.id}`, pack: packSnapshot(best.pv, best.v) } : null
}

export async function generateReferencePallets(userId: number | null, opts: { refreshUnedited?: boolean } = {}): Promise<GenerationResult> {
  const rows = await db
    .select({ pv: s.packagingVersions, v: s.productVariants, pt: s.palletTypes })
    .from(s.packagingVersions)
    .innerJoin(s.productVariants, and(eq(s.productVariants.id, s.packagingVersions.variantId), eq(s.productVariants.active, true)))
    .innerJoin(s.palletTypes, eq(s.palletTypes.id, s.packagingVersions.palletTypeId))
  // só a versão vigente (maior) de cada SKU
  const latest = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    const c = latest.get(r.v.id)
    if (!c || r.pv.version > c.pv.version) latest.set(r.v.id, r)
  }
  const existingRows = await db.select().from(s.palletCompositions).where(eq(s.palletCompositions.active, true))
  const existing = new Map(existingRows.map((x) => [x.name, x]))
  const res: GenerationResult = { created: 0, skipped: 0, refreshed: 0, lines: [] }

  for (const r of [...latest.values()].sort((a, b) => a.v.sku.localeCompare(b.v.sku))) {
    let n = r.pv.unitsPerPallet ?? 0
    if (n <= 0 || !r.pt.active) continue
    const pack = packSnapshot(r.pv, r.v)
    let ref: { doc: PalletDoc; perLayer: number; layers: number }
    let notes: string
    const comp = pack.companions?.[0]
    const kit = comp ? await latestPackBySku(comp.sku) : null
    if (comp && kit) {
      // produto com acompanhante: palete padrão do catálogo com os kits por cima (caixas coletivas)
      const cr = companionReference(palletTypeSnapshot(r.pt), pack, `pv${r.pv.id}`, n, { ...kit, qty: comp.qty })
      if (!cr) continue
      notes = companionNotes(r.v.sku, r.pv.version, n, cr, comp.sku)
      n = cr.n
      ref = { doc: cr.doc, perLayer: 0, layers: 0 }
    } else {
      const b = buildReferencePallet(palletTypeSnapshot(r.pt), pack, `pv${r.pv.id}`, n, `REF · ${r.v.sku} · ${n} u`, TOLERANCE_MM)
      ref = b
      notes = notesFor(r.v.sku, r.pv.version, n, b)
    }
    const name = `REF · ${r.v.sku} · ${n} u`
    ref.doc = { ...ref.doc, name }
    const sum = palletSummary(ref.doc)
    const c = countBySeverity(validatePallet(ref.doc))
    const line = `${name.padEnd(36)} ${r.pt.code.padEnd(14)} ${ref.perLayer ? `${ref.perLayer}/camada × ${ref.layers}` : 'com acompanhantes'}  alt ${sum.totalHeightMm} mm  bruto ${Math.round(sum.grossKg)} kg  crít ${c.CRITICAL} / atenção ${c.WARNING}`

    const prev = existing.get(name)
    if (prev) {
      const unedited = Math.abs(prev.updatedAt.getTime() - prev.createdAt.getTime()) < 1000
      const changed = stable(prev.document.items) !== stable(ref.doc.items) || prev.notes !== notes
      if (opts.refreshUnedited && unedited && changed) {
        // mantém updated_at = created_at para continuar reconhecida como "não editada"
        await db.update(s.palletCompositions).set({ document: ref.doc, notes, updatedAt: prev.createdAt }).where(eq(s.palletCompositions.id, prev.id))
        res.refreshed++
        res.lines.push(`RECALCULADA ${line}`)
      } else res.skipped++
      continue
    }
    await db.insert(s.palletCompositions).values({ name, palletTypeId: r.pt.id, document: ref.doc, notes, createdBy: userId, updatedBy: userId })
    res.created++
    res.lines.push(line)
  }
  return res
}
