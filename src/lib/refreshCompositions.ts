// Sem 'server-only': usado também pelo script de linha de comando.
import { eq } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { buildReferencePallet } from '@/domain/autopallet'
import { kitBoxPack, packKeyOf } from '@/domain/kitBoxes'
import type { PackSnapshot, PalletDoc } from '@/domain/types'
import { companionNotes, companionReference, generateReferencePallets, latestPackBySku } from './referencePallets'
import { packSnapshot, palletTypeSnapshot } from './snapshots'

const TOLERANCE_MM = 25
const sameDims = (a: PackSnapshot, b: PackSnapshot) => a.dims.l === b.dims.l && a.dims.w === b.dims.w && a.dims.h === b.dims.h
/** JSON com chaves ordenadas; price ausente (cópias antigas) equivale a null */
const stable = (v: unknown): string =>
  JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) && 'sku' in v ? { price: null, ...v } : v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

export interface RefreshReport {
  updated: number
  regenerated: number
  archived: number
  review: number
  lines: string[]
}

/**
 * Sincroniza as MONTAGENS ativas com o catálogo atual (embalagem vigente de cada SKU, preço, palete).
 * - Dados da caixa (peso, preço, orientações, nome…) → atualiza a cópia mantendo o arranjo.
 * - REF · SKU · N u com medida da caixa, un./palete ou palete padrão diferentes → recalcula o arranjo.
 * - REF de SKU excluído (inativo) ou sem un./palete/palete → arquivada.
 * - Montagem manual cuja caixa mudou de medida → só avisa (o arranjo precisa de revisão humana).
 * Cargas salvas NÃO mudam (guardam o snapshot da época).
 */
export async function refreshCompositions(opts: { dry?: boolean } = {}): Promise<RefreshReport> {
  const rows = await db.select({ pv: s.packagingVersions, v: s.productVariants }).from(s.packagingVersions).innerJoin(s.productVariants, eq(s.productVariants.id, s.packagingVersions.variantId))
  const latestByVariant = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    const c = latestByVariant.get(r.v.id)
    if (!c || r.pv.version > c.pv.version) latestByVariant.set(r.v.id, r)
  }
  const variantOfPv = new Map(rows.map((r) => [r.pv.id, r.v.id]))
  const bySku = new Map([...latestByVariant.values()].map((r) => [r.v.sku, r]))
  const types = new Map((await db.select().from(s.palletTypes)).map((t) => [t.id, t]))
  const comps = await db.select().from(s.palletCompositions).where(eq(s.palletCompositions.active, true))
  const names = new Set(comps.map((c) => c.name))
  const rep: RefreshReport = { updated: 0, regenerated: 0, archived: 0, review: 0, lines: [] }

  const write = async (c: (typeof comps)[number], set: Partial<typeof s.palletCompositions.$inferInsert>) => {
    if (opts.dry) return
    const unedited = Math.abs(c.updatedAt.getTime() - c.createdAt.getTime()) < 1000
    await db.update(s.palletCompositions).set({ ...set, updatedAt: unedited ? c.createdAt : new Date() }).where(eq(s.palletCompositions.id, c.id))
  }

  for (const c of comps.sort((a, b) => a.name.localeCompare(b.name))) {
    const doc = c.document as PalletDoc
    const ref = c.name.match(/^REF · (.+) · (\d+) u$/)

    // ---- montagens de referência: refletem exatamente o cadastro do SKU
    if (ref) {
      const r = bySku.get(ref[1])
      const pt = r?.pv.palletTypeId != null ? types.get(r.pv.palletTypeId) : undefined
      const n = r?.pv.unitsPerPallet ?? 0
      if (!r || !r.v.active || !pt || !pt.active || n <= 0) {
        if (!opts.dry) await db.update(s.palletCompositions).set({ active: false, updatedAt: new Date() }).where(eq(s.palletCompositions.id, c.id))
        rep.archived++
        rep.lines.push(`ARQUIVADA   ${c.name} — ${!r ? 'SKU não encontrado' : !r.v.active ? 'SKU excluído do catálogo' : n <= 0 ? 'sem un./palete' : 'sem palete padrão ativo'}`)
        continue
      }
      const pack = packSnapshot(r.pv, r.v)
      const ptSnap = palletTypeSnapshot(pt)
      // produto com acompanhante obrigatório (ex.: Hydroforce + kit): palete montado com os kits por cima
      const comp = pack.companions?.[0]
      if (comp) {
        const kit = await latestPackBySku(comp.sku)
        const cr = kit ? companionReference(ptSnap, pack, `pv${r.pv.id}`, n, { ...kit, qty: comp.qty }) : null
        if (!cr) {
          rep.review++
          rep.lines.push(`REVISAR     ${c.name} — não foi possível montar com ${comp.sku} por cima (${kit ? 'altura' : 'acompanhante não cadastrado'})`)
          continue
        }
        const name = `REF · ${r.v.sku} · ${cr.n} u`
        const fresh = { ...cr.doc, name, stackable: doc.stackable, maxTopKg: doc.maxTopKg, accessoriesKg: doc.accessoriesKg }
        if (stable(fresh.items) === stable(doc.items) && stable(fresh.packs) === stable(doc.packs) && name === c.name && c.palletTypeId === pt.id) continue
        if (name !== c.name && names.has(name)) {
          rep.review++
          rep.lines.push(`REVISAR     ${c.name} — já existe "${name}"`)
          continue
        }
        const notes = companionNotes(r.v.sku, r.pv.version, n, cr, comp.sku)
        await write(c, { name, palletTypeId: pt.id, document: fresh, notes })
        names.add(name)
        rep.regenerated++
        rep.lines.push(`RECALCULADA ${name}${name !== c.name ? ` (era ${c.name})` : ''} — ${notes.replace(/^Gerada automaticamente a partir da embalagem [^:]+: /, '').replace(/\. VALIDAR.*$/, '')}`)
        continue
      }
      const old = Object.values(doc.packs)[0]
      const geometryChanged = !old || !sameDims(old, pack) || Number(ref[2]) !== n || c.palletTypeId !== pt.id || stable(ptSnap) !== stable(doc.palletType)
      if (geometryChanged) {
        const name = `REF · ${r.v.sku} · ${n} u`
        if (name !== c.name && names.has(name)) {
          rep.review++
          rep.lines.push(`REVISAR     ${c.name} — já existe "${name}"`)
          continue
        }
        const b = buildReferencePallet(ptSnap, pack, `pv${r.pv.id}`, n, name, TOLERANCE_MM)
        const notes =
          `Gerada automaticamente a partir da embalagem ${r.v.sku} v${r.pv.version} (${n} un./palete). ` +
          `Padrão "${b.pattern.name}": ${b.perLayer} por camada × ${b.layers} camada(s). VALIDAR antes de usar em carga real.`
        await write(c, { name, palletTypeId: pt.id, document: { ...b.doc, stackable: doc.stackable, maxTopKg: doc.maxTopKg, accessoriesKg: doc.accessoriesKg }, notes })
        names.add(name)
        rep.regenerated++
        const why = [
          old && !sameDims(old, pack) ? `caixa ${old.dims.l}×${old.dims.w}×${old.dims.h} → ${pack.dims.l}×${pack.dims.w}×${pack.dims.h}` : '',
          Number(ref[2]) !== n ? `${ref[2]} → ${n} un./palete` : '',
          c.palletTypeId !== pt.id ? `palete → ${pt.code}` : stable(ptSnap) !== stable(doc.palletType) ? 'dados do palete' : '',
        ].filter(Boolean)
        rep.lines.push(`RECALCULADA ${name}${name !== c.name ? ` (era ${c.name})` : ''} — ${why.join('; ')}`)
        continue
      }
      // mesma geometria: só troca a cópia da caixa (peso, preço…)
      if (stable(old) !== stable(pack) || !doc.packs[`pv${r.pv.id}`]) {
        const oldKey = Object.keys(doc.packs)[0]
        const key = `pv${r.pv.id}`
        await write(c, { document: { ...doc, packs: { [key]: pack }, items: doc.items.map((i) => (i.packId === oldKey ? { ...i, packId: key } : i)) } })
        rep.updated++
        rep.lines.push(`ATUALIZADA  ${c.name} — ${diffPack(old, pack)}`)
      }
      continue
    }

    // ---- montagens manuais: atualiza as cópias das caixas; mudança de medida → revisão
    const packs: PalletDoc['packs'] = {}
    const rename = new Map<string, string>()
    const changes: string[] = []
    const review: string[] = []
    for (const [key, old] of Object.entries(doc.packs)) {
      const vid = variantOfPv.get(old.packagingVersionId)
      const r = vid != null ? latestByVariant.get(vid) : undefined
      if (!r) {
        packs[key] = old
        review.push(`${old.sku}: embalagem não encontrada`)
        continue
      }
      // caixa coletiva de kits (26 / meia caixa): refeita a partir da individual vigente, mesmo conteúdo
      const pack = old.kitBox ? kitBoxPack(packSnapshot(r.pv, r.v), old.kitBox.kind, old.kitBox.kits) : packSnapshot(r.pv, r.v)
      if (!r.v.active) review.push(`${old.sku}: SKU excluído do catálogo`)
      if (!sameDims(old, pack)) {
        packs[key] = old
        review.push(`${old.sku}: caixa ${old.dims.l}×${old.dims.w}×${old.dims.h} → ${pack.dims.l}×${pack.dims.w}×${pack.dims.h}`)
        continue
      }
      const nk = packKeyOf(pack)
      packs[nk] = pack
      if (nk !== key) rename.set(key, nk)
      if (stable(old) !== stable(pack)) changes.push(`${old.sku}: ${diffPack(old, pack)}`)
    }
    const pt = types.get(c.palletTypeId)
    const ptSnap = pt ? palletTypeSnapshot(pt) : doc.palletType
    if (stable(ptSnap) !== stable(doc.palletType)) changes.push('dados do palete')
    if (changes.length || rename.size) {
      await write(c, { document: { ...doc, palletType: ptSnap, packs, items: doc.items.map((i) => (rename.has(i.packId) ? { ...i, packId: rename.get(i.packId)! } : i)) } })
      rep.updated++
      rep.lines.push(`ATUALIZADA  ${c.name} — ${changes.join('; ') || 'nova versão da embalagem'}`)
    }
    if (review.length) {
      rep.review++
      rep.lines.push(`REVISAR     ${c.name} — ${review.join('; ')}`)
    }
  }
  return rep
}

function diffPack(a: PackSnapshot | undefined, b: PackSnapshot): string {
  if (!a) return 'nova caixa'
  const d: string[] = []
  const f = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
  if (a.netKg !== b.netKg || a.grossKg !== b.grossKg) d.push(`peso ${f(a.netKg)}/${f(a.grossKg)} → ${f(b.netKg)}/${f(b.grossKg)} kg`)
  if (stable(a.price) !== stable(b.price)) d.push(`preço ${a.price ? `${a.price.currency} ${a.price.amount}` : '—'} → ${b.price ? `${b.price.currency} ${b.price.amount}` : '—'}`)
  if (a.name !== b.name) d.push(`nome "${b.name}"`)
  if (a.version !== b.version) d.push(`embalagem v${a.version} → v${b.version}`)
  if (stable(a.allowedOrientations) !== stable(b.allowedOrientations) || a.stackable !== b.stackable || a.maxStackLayers !== b.maxStackLayers || a.maxStackKg !== b.maxStackKg) d.push('regras de orientação/empilhamento')
  return d.join(', ') || 'outros dados'
}

/**
 * Chamado após qualquer edição do catálogo (produto, preço, embalagem, exclusão):
 * sincroniza as montagens e cria as REF de SKUs novos. Registra na auditoria.
 */
export async function syncCompositionsWithCatalog(userId: number | null): Promise<void> {
  const r = await refreshCompositions()
  const g = await generateReferencePallets(userId)
  if (r.updated || r.regenerated || r.archived || g.created) {
    await db.insert(s.auditLog).values({
      entity: 'pallet_composition',
      entityId: null,
      action: 'sync_catalog',
      userId,
      diff: { atualizadas: r.updated, recalculadas: r.regenerated, arquivadas: r.archived, revisar: r.review, criadas: g.created, log: [...r.lines, ...g.lines] },
    })
  }
}
