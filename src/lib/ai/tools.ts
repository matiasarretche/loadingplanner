import 'server-only'
import { withNoneWorkArea } from '@/domain/shipmentType'
import { fitNone } from '@/domain/noEquipment'
import { BusinessArea, citesLonaLine, filterByLonaRule, isRuleLona, LONA_RULE_TEXT } from '@/domain/lonaRule'
import { and, eq, inArray, like } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema as s } from '@/db'
import { buildReferencePallet } from '@/domain/autopallet'
import { composeMix, maxAdditional, placeLooseBoxes, placePallets, removeUnits, repack, StopReason } from '@/domain/autoload'
import { balanceWeight } from '@/domain/balance'
import { DEFAULT_QUADRANT_RULES, quadrantShares } from '@/domain/quadrants'
import { removeBoxesFromPallet } from '@/domain/partial'
import { addBoxesToPallet, palletByNumber, palletLabel } from '@/domain/palletBoxes'
import { loadState } from '@/domain/state'
import { countBySeverity, sortIssues } from '@/domain/issues'
import { effectiveLimits, loadGeometries, validateLoad } from '@/domain/load'
import { placeMixedPalletsInLoad } from '@/domain/mixedLoad'
import { freeCapacity, groupsOfDoc, LooseGroup, PalletGroup, planNotes, splitIntoUnits } from '@/domain/multiUnit'
import { addMissingCompanions, companionLines, palletHeightLimit } from '@/domain/companions'
import { kitBaseOf, kitFamilyOf, packKeyOf } from '@/domain/kitBoxes'
import { kitPalletForHeight } from '@/domain/kitPallet'
import { optimizeMixedPallets, OrderLine, transportMaxHeight } from '@/domain/mixedPallets'
import { LogisticsResolution, resolveLogistics } from '@/domain/logisticsRules'
import { bestLayer } from '@/domain/autopallet'
import { palletSummary } from '@/domain/pallet'
import { technicalAttrs } from '@/domain/productSpec'
import type { LoadDoc, LoadUnit, PackSnapshot, PalletDoc, PalletTypeSnapshot } from '@/domain/types'
import type { CurrentUser } from '@/lib/auth'
import { can, Permission } from '@/lib/roles'
import { containerSpace, packSnapshot, palletTypeSnapshot, vehicleSpace } from '@/lib/snapshots'
import { isUnambiguous, resolveProducts } from './productMatch'
import type { ToolSpec } from './provider'
import { cargoVehicleWhere } from '@/lib/vehicles'

// ---------------------------------------------------------------------------
// Contexto de execução (por requisição: sem estado global entre usuários)
// ---------------------------------------------------------------------------

export interface ToolContext {
  user: CurrentUser
  /** rascunho da carga desta conversa; as tools o substituem por uma nova versão */
  draft: LoadDoc
  catalog?: CatalogEntry[]
  /** regras logísticas do envio (modalidade + destino): palete padrão e peso máximo da carga */
  logistics?: LogisticsResolution | null
  /** pedido em várias unidades (split_into_units): unidades 2..N da proposta (a 1ª é o draft) */
  extraUnits?: LoadDoc[]
  /** área do envio (exportação × mercado interno): define a linha das lonas até 14 m (domain/lonaRule) */
  area?: BusinessArea
  /** avisos da divisão (o que não coube, equipamento menor para o remanente) */
  unitNotes?: string[]
}

interface CatalogEntry {
  variantId: number
  sku: string
  name: string
  family: string
  line: string
  brand: string
  price: number | null
  priceCurrency: string
  priceUnit: 'UNIT' | 'BOX' | 'PALLET'
  attrs: Record<string, unknown>
  pv: typeof s.packagingVersions.$inferSelect | null
  pallet: typeof s.palletTypes.$inferSelect | null
}

async function catalog(ctx: ToolContext): Promise<CatalogEntry[]> {
  if (ctx.catalog) return ctx.catalog
  const rows = await db
    .select({ v: s.productVariants, p: s.products, f: s.productFamilies })
    .from(s.productVariants)
    .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
    .innerJoin(s.productFamilies, eq(s.productFamilies.id, s.products.familyId))
    .where(and(eq(s.productVariants.active, true), eq(s.productFamilies.active, true)))
  const packs = await db.select().from(s.packagingVersions)
  const pallets = new Map((await db.select().from(s.palletTypes)).map((p) => [p.id, p]))
  const latest = new Map<number, (typeof packs)[number]>()
  for (const p of packs) {
    const c = latest.get(p.variantId)
    if (!c || p.version > c.version) latest.set(p.variantId, p)
  }
  ctx.catalog = rows.map(({ v, p, f }) => {
    const pv = latest.get(v.id) ?? null
    return { variantId: v.id, sku: v.sku, name: v.name, family: f.name, line: p.name, brand: v.brand, price: v.price, priceCurrency: v.priceCurrency, priceUnit: v.priceUnit, attrs: technicalAttrs(v.attrs, v), pv, pallet: pv?.palletTypeId ? pallets.get(pv.palletTypeId) ?? null : null }
  })
  return ctx.catalog
}

async function entryBySku(ctx: ToolContext, sku: string) {
  const all = await catalog(ctx)
  const norm = (x: string) => x.toUpperCase().replace(/\s+/g, '')
  return all.find((e) => norm(e.sku) === norm(sku)) ?? null
}

const capacityL = (e: CatalogEntry) => (typeof e.attrs.capacidade_l === 'number' ? e.attrs.capacidade_l : null)

/** Dados que faltam para paletizar um SKU (nunca inventar). */
function missingData(e: CatalogEntry): string[] {
  const m: string[] = []
  if (!e.pv) return ['embalagem (medidas da caixa, pesos)']
  if (!e.pv.unitsPerPallet) m.push('caixas por palete')
  if (!e.pallet) m.push('palete padrão')
  if (e.pv.netKg <= 0) m.push('peso líquido (o bruto usado é só a tara da embalagem)')
  if (e.pallet && (e.pallet.heightMm == null || e.pallet.tareKg == null)) m.push(`altura/tara do palete ${e.pallet.code}`)
  return m
}

/**
 * Palete de referência do SKU: montagem REF existente ou gerada pelo motor a partir da embalagem.
 * Se a regra logística do envio define outro palete (ex.: marítimo = 1,15 × 1,15), o palete é montado
 * nele com o mesmo número de camadas do padrão — só se couberem ao menos as mesmas caixas por camada do
 * palete completo do catálogo; senão (ou se a caixa não couber) fica o palete padrão do produto.
 */
async function palletForSku(ctx: ToolContext, sku: string): Promise<{ key: string; pallet: PalletDoc; source: string } | { error: string }> {
  const e = await entryBySku(ctx, sku)
  if (!e) return { error: `Produto ${sku} não encontrado.` }
  const ruleCode = ctx.logistics?.palletTypeCodes?.[0] ?? null
  const useRule = Boolean(ruleCode && e.pallet && e.pallet.code !== ruleCode && e.pv?.unitsPerPallet)
  let keepStd = ''
  if (useRule && e.pv && e.pallet) {
    const [rt] = await db.select().from(s.palletTypes).where(eq(s.palletTypes.code, ruleCode!)).limit(1)
    if (rt) {
      const prefix = `ai:${e.sku}:${rt.code}:`
      const pack = packSnapshot(e.pv, { ...variantStub(e) })
      const ruleSnap = palletTypeSnapshot(rt)
      const ruleLayer = bestLayer(ruleSnap, pack)
      const perRule = ruleLayer.slots.length
      const stdLayer = bestLayer(palletTypeSnapshot(e.pallet), pack)
      const fits = perRule > 0 && ruleLayer.sizeX <= rt.lengthMm && ruleLayer.sizeY <= rt.widthMm
      // o pallet completo do catálogo (unidades por palete, caixas deitadas no padrão) tem prioridade: o palete
      // da regra só substitui se mantiver ao menos as mesmas caixas por camada (ex.: SB 9×60 = 2 por camada no PBR-1,
      // só 1 no PCF-1150 → fica o PBR-1 com 10 un.)
      if (fits && perRule < stdLayer.slots.length) keepStd = ` (palete padrão do catálogo ${e.pallet.code} mantido: no ${rt.code} caberiam só ${perRule} caixa(s) por camada em vez de ${stdLayer.slots.length})`
      else if (fits) {
        for (const [key, p] of Object.entries(ctx.draft.pallets)) if (key.startsWith(prefix)) return { key, pallet: p, source: 'já na carga' }
        const layers = Math.ceil((e.pv.unitsPerPallet ?? 0) / Math.max(1, stdLayer.slots.length))
        // nunca acima do máximo de caixas por palete do catálogo
        const n = Math.min(perRule * layers, e.pv.unitsPerPallet ?? Infinity)
        const name = `REF · ${e.sku} · ${n} u · ${rt.code}`
        const r = buildReferencePallet(ruleSnap, pack, `pv${e.pv.id}`, n, name, 0)
        return { key: `${prefix}pv${e.pv.id}`, pallet: r.doc, source: `regra logística: palete ${rt.code} (${n} un., ${layers} camada(s))` }
      }
    }
  }
  // 1) já existe no rascunho (mantém o mesmo snapshot) — se for da altura desta carga: depois de trocar o
  // equipamento (ex.: 40' HC → 20' Dry) a REF de 2.390 mm não passa mais na porta, e a reduzida "até 2.292 mm"
  // não é o palete completo de volta no 40' HC; nesses casos recalcula
  const limit = palletHeightLimit(ctx.draft)
  for (const [key, p] of Object.entries(ctx.draft.pallets)) {
    if (keepStd && key.startsWith(`ai:${e.sku}:${ruleCode}:`)) continue // montagem antiga no palete da regra: não reaproveitar
    if (!key.startsWith(`ai:${e.sku}:`)) continue
    const hKey = key.match(/:h(d+)$/)
    if (palletSummary(p).totalHeightMm > limit + 0.5 || (hKey && Number(hKey[1]) !== Math.round(limit))) continue
    return { key, pallet: p, source: 'já na carga' }
  }
  // 2) montagem REF ativa
  const [ref] = await db
    .select()
    .from(s.palletCompositions)
    .where(and(eq(s.palletCompositions.active, true), like(s.palletCompositions.name, `REF · ${e.sku} · %`)))
    .limit(1)
  const note = keepStd || (useRule ? ` (a caixa não cabe no palete da regra ${ruleCode}; usado o padrão do produto)` : '')
  if (ref && ref.document.items.length) {
    const key = `ai:${e.sku}:c${ref.id}r${ref.updatedAt.getTime()}`
    // REF com kits mais alta que esta carga (só 40' HC / rodoviário): o maior palete que cabe (domain/kitPallet)
    const fit = kitPalletForHeight(ref.document, limit)
    if (fit) return { key: `${key}:h${Math.round(limit)}`, pallet: fit.pallet, source: `montagem ${ref.name}${note} — ${fit.note}` }
    return { key, pallet: ref.document, source: `montagem ${ref.name}${note}` }
  }
  // 3) gerar pela embalagem
  if (!e.pv || !e.pv.unitsPerPallet || !e.pallet) {
    return { error: `Não é possível paletizar ${e.sku}: faltam dados no cadastro (${missingData(e).join(', ')}).` }
  }
  const name = `REF · ${e.sku} · ${e.pv.unitsPerPallet} u`
  const r = buildReferencePallet(palletTypeSnapshot(e.pallet), packSnapshot(e.pv, { ...variantStub(e) }), `pv${e.pv.id}`, e.pv.unitsPerPallet, name, 25)
  return { key: `ai:${e.sku}:pv${e.pv.id}`, pallet: r.doc, source: `gerado da embalagem${note}` }
}
function variantStub(e: CatalogEntry) {
  // atributos e preço do cadastro vão junto: o snapshot leva regras do produto (ex.: kit obrigatório) e preço
  return { id: e.variantId, sku: e.sku, name: e.name, brand: e.brand, attrs: e.attrs, price: e.price, priceCurrency: e.priceCurrency, priceUnit: e.priceUnit } as typeof s.productVariants.$inferSelect
}

/**
 * Regra de acompanhantes (ex.: 1 kit por Hydroforce) aplicada depois de qualquer alteração da carga
 * feita pela IA: completa os faltantes como caixas soltas e informa no resultado da ferramenta.
 */
async function ensureCompanions(ctx: ToolContext) {
  const r = addMissingCompanions(ctx.draft, (sku) => {
    const e = (ctx.catalog ?? []).find((x) => x.sku.toUpperCase() === sku.toUpperCase())
    return e?.pv ? { packId: `pv${e.pv.id}`, pack: packSnapshot(e.pv, variantStub(e)) } : null
  })
  if (r.added.length) ctx.draft = r.doc
  return r.added
}

/** SKUs contidos numa unidade (para remover/substituir por produto). */
function unitSkus(doc: LoadDoc, u: LoadUnit): string[] {
  if (u.kind === 'PACKAGE') return [doc.packs[u.packId]?.sku ?? '']
  return Object.values(doc.pallets[u.palletKey]?.packs ?? {}).map((p) => p.sku)
}

type MixedMode = 'FCL' | 'LCL' | 'AIR' | 'ROAD' | 'PALLETS_ONLY'

/**
 * Pedido (unidades por SKU) → paletes mistos pelo motor determinístico, com os acompanhantes
 * obrigatórios, a regra logística (palete padrão) e a altura máxima da modalidade.
 */
async function buildMixedPallets(
  ctx: ToolContext,
  lines: { sku: string; units: number }[],
  mode: MixedMode,
  o: { maxHeightMm?: number; maxKgPerPallet?: number; destination?: string } = {},
): Promise<{ error: string } | { r: ReturnType<typeof optimizeMixedPallets>; notes: string[]; H: number }> {
  const order: OrderLine[] = []
  const types = new Map<number, PalletTypeSnapshot>()
  const notes: string[] = []
  for (const l of lines) {
    const e = await entryBySku(ctx, l.sku)
    if (!e) return { error: `Produto ${l.sku} não encontrado.` }
    if (!e.pv) return { error: `Produto ${e.sku} sem embalagem cadastrada (medidas/pesos).` }
    const pack = packSnapshot(e.pv, variantStub(e))
    const boxes = Math.ceil(l.units / Math.max(1, pack.unitsPerPackage))
    if (boxes * pack.unitsPerPackage !== l.units) notes.push(`${e.sku}: ${l.units} un. arredondadas para ${boxes} caixa(s) de ${pack.unitsPerPackage} un.`)
    order.push({ packId: `pv${e.pv.id}`, pack, boxes })
    if (e.pallet) types.set(e.pallet.id, palletTypeSnapshot(e.pallet))
    else notes.push(`${e.sku} sem palete padrão cadastrado.`)
  }
  // acompanhantes obrigatórios (ex.: 1 kit por Hydroforce) entram no pedido automaticamente, em kits;
  // o motor monta as caixas (26 / meia caixa / individuais) por palete
  for (const c of companionLines(order)) {
    const ce = await entryBySku(ctx, c.sku)
    if (!ce?.pv) {
      notes.push(`Acompanhante ${c.sku} (obrigatório para ${c.for.join(', ')}) não cadastrado.`)
      continue
    }
    const packId = `pv${ce.pv.id}`
    const pack = packSnapshot(ce.pv, variantStub(ce))
    const boxes = Math.ceil(c.kits / Math.max(1, pack.unitsPerPackage))
    const have = order.find((x) => x.packId === packId)
    if (have) have.boxes = Math.max(have.boxes, boxes)
    else order.push({ packId, pack, boxes })
    notes.push(`${c.kits} × ${c.sku} incluído(s) automaticamente (1 por ${c.for.join(', ')})${kitFamilyOf(c.sku) ? ', em caixas de 26 kits / meia caixa (até 13) / individuais por palete' : ''}.`)
  }
  if (!types.size) return { error: 'Nenhum dos produtos tem palete padrão cadastrado; não há palete para montar.' }
  const space = mode === 'FCL' || mode === 'ROAD' || (mode === 'AIR' && ctx.draft.space.transport === 'AIR') ? ctx.draft.space : null
  // limite de altura dos perfis da carga só vale quando os paletes vão neste equipamento
  const H = transportMaxHeight(mode, space, o.maxHeightMm ?? null, space ? effectiveLimits(ctx.draft).heightMm.value : null)
  if (!H) return { error: 'Informe a altura máxima do palete carregado (max_height_mm) para esta modalidade: depende do operador logístico.' }
  // regra logística central: palete padrão por modalidade + destino; o palete do produto fica como reserva
  const lmode = mode === 'FCL' || mode === 'LCL' ? 'SEA' : mode === 'ROAD' ? 'ROAD' : mode === 'AIR' ? 'AIR' : null
  const rules = lmode ? resolveLogistics({ mode: lmode, destination: o.destination ?? ctx.logistics?.context.destination ?? null }) : null
  const ruleTypes = rules?.palletTypeCodes?.length ? (await db.select().from(s.palletTypes).where(inArray(s.palletTypes.code, rules.palletTypeCodes))).map(palletTypeSnapshot) : []
  const r = optimizeMixedPallets(order, {
    palletTypes: ruleTypes.length ? ruleTypes : [...types.values()],
    fallbackPalletTypes: ruleTypes.length ? [...types.values()] : undefined,
    maxHeightMm: H,
    maxLoadKg: o.maxKgPerPallet ?? null,
  })
  notes.push(...r.notes)
  if (rules?.applied.length) notes.push(`Regras: ${rules.applied.map((a) => a.description).join(' · ')}`)
  return { r, notes, H }
}

/** Equipamentos ativos do mesmo modal do rascunho (para sugerir um menor para o remanente). */
async function sameModeSpaces(doc: LoadDoc) {
  if (doc.space.kind === 'VEHICLE') return (await db.select().from(s.vehicleTypes).where(cargoVehicleWhere())).map(vehicleSpace)
  return (await db.select().from(s.containerTypes).where(eq(s.containerTypes.active, true))).map(containerSpace).filter((c) => (c.transport ?? 'SEA') === (doc.space.transport ?? 'SEA'))
}

// ---------------------------------------------------------------------------
// Resumo compacto da carga (contexto da IA — poucos tokens)
// ---------------------------------------------------------------------------

export async function summarizeLoad(ctx: ToolContext, doc0: LoadDoc = ctx.draft) {
  // envio sem equipamento: o resumo usa o piso do tamanho do conteúdo (não o piso de trabalho)
  const doc = fitNone(doc0)
  const { issues, summary: sm } = validateLoad(doc)
  const cat = await catalog(ctx)
  const capBySku = new Map(cat.map((e) => [e.sku, capacityL(e)]))
  const groups = new Map<string, { name: string; skus: string[]; count: number; grossKgEach: number }>()
  for (const g of loadGeometries(doc)) {
    const key = g.unit.kind === 'PALLET' ? g.unit.palletKey : `pack:${g.unit.packId}`
    const cur = groups.get(key) ?? { name: g.unit.kind === 'PALLET' ? doc.pallets[g.unit.palletKey].name : 'volume solto', skus: g.bySku.map((l) => l.sku), count: 0, grossKgEach: Math.round(g.grossKg) }
    cur.count++
    groups.set(key, cur)
  }
  const liters = sm.bySku.reduce((t, l) => t + (capBySku.get(l.sku) ?? 0) * l.units, 0)
  // conteúdo de cada palete (etiqueta P# do 3D): caixas por produto e o máximo do catálogo
  const contents = new Map<string, string[]>()
  for (const u of doc.units) {
    if (u.kind !== 'PALLET') continue
    const p = doc.pallets[u.palletKey]
    if (!p) continue
    const n = new Map<string, number>()
    for (const it of p.items) n.set(it.packId, (n.get(it.packId) ?? 0) + 1)
    const txt = [...n].map(([id, c]) => {
      const k = p.packs[id]
      return `${c}×${k?.sku ?? '?'}${k?.boxesPerPallet ? ` (máx ${k.boxesPerPallet})` : ''}`
    }).join(' + ')
    contents.set(txt, [...(contents.get(txt) ?? []), palletLabel(doc, u)])
  }
  const st = loadState(doc)
  const c = countBySeverity(issues)
  return {
    equipment: { code: doc.space.code, name: doc.space.name, innerMm: doc.space.inner, doorMm: doc.space.door, verification: doc.space.verification },
    limits: { payloadKg: sm.limits.payloadKg.value, payloadSource: sm.limits.payloadKg.source, grossKg: sm.limits.grossKg.value, heightMm: sm.limits.heightMm.value },
    totals: {
      pallets: sm.pallets,
      looseUnits: sm.looseUnits,
      boxes: sm.packages,
      units: sm.units,
      netKg: Math.round(sm.netKg),
      payloadKg: Math.round(sm.payloadKg),
      payloadPct: sm.payloadPct == null ? null : Math.round(sm.payloadPct * 10) / 10,
      grossKg: Math.round(sm.grossKg),
      cbm: Math.round(sm.cbmUnits * 100) / 100,
      volumeUtilPct: Math.round(sm.volumeUtilPct * 10) / 10,
      floorUtilPct: Math.round(sm.floorUtilPct * 10) / 10,
      freeLengthMm: sm.freeLengthMm,
      cgLongDevPct: sm.cgLongDevPct == null ? null : Math.round(sm.cgLongDevPct * 10) / 10,
      storageCapacityLiters: liters || null,
      /** % do peso total por quadrante (NORTE = frente/cabine, SUL = traseira; OESTE = lado do motorista) */
      weightPct: (() => {
        const q = quadrantShares(doc)
        const r1 = (v: number) => Math.round(v * 10) / 10
        return q.totalKg > 0 ? { NE: r1(q.pct.NE), NO: r1(q.pct.NO), SE: r1(q.pct.SE), SO: r1(q.pct.SO), north: r1(q.northPct), south: r1(q.southPct) } : null
      })(),
    },
    palletGroups: [...groups.values()],
    /** caixas de cada palete por etiqueta (P1, P2…): "6×SKU (máx 6)" → paletes */
    palletContents: [...contents].map(([content, labels]) => ({ content, pallets: labels.join(",") })),
    /** completos × parciais, caixas soltas no piso × por cima, folgas de altura/peso/volume */
    state: {
      ...st.counts,
      maxTopMm: st.maxTopMm,
      heightLimitMm: st.heightLimitMm,
      freeHeightMm: Math.max(0, st.heightLimitMm - st.maxTopMm),
      remainingPayloadKg: st.remainingPayloadKg == null ? null : Math.round(st.remainingPayloadKg),
      freeVolumeM3: Math.round(st.freeVolumeM3 * 100) / 100,
    },
    bySku: sm.bySku.map((l) => ({ sku: l.sku, boxes: l.packages, units: l.units, grossKg: Math.round(l.grossKg) })),
    issues: { critical: c.CRITICAL, warning: c.WARNING, criticalMessages: sortIssues(issues).filter((i) => i.severity === 'CRITICAL').slice(0, 5).map((i) => i.message) },
  }
}

/** Versão curta do resumo para resultados de tools (menos tokens). */
export function compact(sm: Awaited<ReturnType<typeof summarizeLoad>>) {
  const t = sm.totals
  return {
    equipment: sm.equipment.code,
    state: sm.state,
    pallets: sm.palletGroups.map((g) => ({ skus: g.skus.join('+'), count: g.count })),
    palletContents: sm.palletContents.slice(0, 30),
    payloadKg: t.payloadKg,
    payloadPct: t.payloadPct,
    floorPct: t.floorUtilPct,
    /** capacidade de armazenamento TOTAL = soma da capacidade (L) de todas as unidades de produto da carga */
    totalStorageCapacityLiters: t.storageCapacityLiters,
    freeLengthMm: t.freeLengthMm,
    weightPct: t.weightPct,
    critical: sm.issues.criticalMessages.slice(0, 3),
    warnings: sm.issues.warning,
  }
}

const STOP_TEXT: Record<StopReason, string> = {
  done: 'quantidade pedida colocada',
  no_space: 'sem espaço físico livre no equipamento',
  payload: 'limite de payload efetivo atingido',
  door: 'o palete não passa pela porta do equipamento',
  height: 'o palete é mais alto que a altura útil do equipamento',
}

// ---------------------------------------------------------------------------
// Definição das tools
// ---------------------------------------------------------------------------

interface ToolDef<I extends z.ZodTypeAny> {
  spec: ToolSpec
  input: I
  /** permissão exigida além do login (mesma regra das ações da UI) */
  permission?: Permission
  /** altera o rascunho? */
  mutates: boolean
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<unknown>
}

const def = <I extends z.ZodTypeAny>(d: ToolDef<I>) => d

const sku = z.string().min(1).max(60)
const qty = z.number().int().min(1).max(500)

export const TOOLS = [
  def({
    spec: {
      name: 'search_products',
      description:
        'Busca produtos do catálogo por texto livre (código, descrição, família, marca, medidas, capacidade em litros: "hidrosilo 10 mil", "silo bolsa 9 × 60", "ecobag 9x60"). Regra de MARCA aplicada pelo motor: se o texto cita uma marca (EcoBag, ProBag, Bridon/Brydon, ADP…) só ela; se não cita, PACIFIL. Retorna candidatos ranqueados, a marca usada e "unambiguous". Passe o texto do usuário com a marca, se houver. Use antes de qualquer operação com produtos.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'texto do usuário que identifica o produto' }, family: { type: 'string', description: 'filtrar por nome de família (opcional)' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    input: z.object({ query: z.string().min(1).max(200), family: z.string().max(80).optional() }),
    mutates: false,
    run: async (ctx, i) => {
      let cat = await catalog(ctx)
      if (i.family) cat = cat.filter((e) => e.family.toLowerCase().includes(i.family!.toLowerCase()))
      // regra das lonas até 14 m: exportação = Lona padrão (plana), mercado interno = BPF (se o pedido não citar a linha)
      const explicitLine = citesLonaLine(i.query)
      if (ctx.area) cat = filterByLonaRule(cat, ctx.area, i.query)
      const found = resolveProducts(i.query, cat, 5)
      const all = found.results
      const unambiguous = isUnambiguous(all)
      // quando é inequívoco, devolve só o melhor; senão, só os que competem com ele
      const ranked = unambiguous ? all.slice(0, 1) : all.filter((r) => r.score >= all[0].score - 25)
      return {
        unambiguous,
        brand: found.brand.key ? `${found.brand.key}${found.brand.defaulted ? ' (padrão: o usuário não citou marca)' : ''}` : null,
        ...(found.brand.note ? { brandNote: found.brand.note } : {}),
        ...(ranked.some((r) => isRuleLona(r.item.name))
          ? { lonaRule: ctx.area ? (explicitLine ? 'linha citada no pedido: vale o pedido' : `aplicada: ${ctx.area === 'EXPORT' ? 'exportação → Lona padrão (plana)' : 'mercado interno → Lona BPF'}`) : `área não definida — ${LONA_RULE_TEXT} Pergunte se é exportação ou mercado interno.` }
          : {}),
        candidates: ranked.map((r) => ({
          sku: r.item.sku,
          name: r.item.name,
          brand: r.item.brand,
          family: r.item.family,
          ...(capacityL(r.item) ? { liters: capacityL(r.item) } : {}),
          ...(missingData(r.item).length ? { missing: missingData(r.item) } : {}),
        })),
      }
    },
  }),
  def({
    spec: {
      name: 'get_product_logistics',
      description: 'Dados logísticos completos de um SKU: caixa, pesos, caixas por palete, palete padrão e o palete de referência montado pelo motor (camadas, altura, peso bruto). Indica dados faltantes.',
      inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
    },
    input: z.object({ sku }),
    mutates: false,
    run: async (ctx, i) => {
      const e = await entryBySku(ctx, i.sku)
      if (!e) return { error: `Produto ${i.sku} não encontrado no catálogo.` }
      const p = await palletForSku(ctx, e.sku)
      const ref = 'error' in p ? null : palletSummary(p.pallet)
      return {
        sku: e.sku,
        name: e.name,
        family: e.family,
        capacityLiters: capacityL(e),
        attrs: e.attrs,
        packaging: e.pv
          ? {
              version: e.pv.version,
              boxMm: { l: e.pv.lengthMm, w: e.pv.widthMm, h: e.pv.heightMm },
              netKg: e.pv.netKg,
              grossKg: e.pv.grossKg,
              unitsPerBox: e.pv.unitsPerPackage,
              boxesPerPallet: e.pv.unitsPerPallet,
              stackable: e.pv.stackable,
              dataStatus: e.pv.verification,
            }
          : null,
        pallet: e.pallet ? { code: e.pallet.code, name: e.pallet.name, mm: { l: e.pallet.lengthMm, w: e.pallet.widthMm, h: e.pallet.heightMm }, tareKg: e.pallet.tareKg, dynamicMaxKg: e.pallet.dynamicMaxKg } : null,
        referencePallet:
          'error' in p
            ? { error: p.error }
            : {
                source: p.source,
                boxes: ref!.packages,
                /** UNIDADES deste produto num palete completo padrão (sem acompanhantes como o KIT-HF) */
                productUnitsPerPallet: p.pallet.items.reduce((t, it) => { const k = p.pallet.packs[it.packId]; return t + (k && k.sku === e.sku ? k.unitsPerPackage : 0) }, 0),
                heightMm: ref!.totalHeightMm,
                grossKg: Math.round(ref!.grossKg),
                footprintMm: { l: ref!.envelope.size.x, w: ref!.envelope.size.y },
                stackable: p.pallet.stackable,
              },
        missingData: missingData(e),
      }
    },
  }),
  def({
    spec: {
      name: 'list_equipment',
      description: 'Lista contêineres e veículos cadastrados (código, medidas internas, porta, tara, payload, bruto máximo). Use para identificar o equipamento pedido ("40 HC", "20 pés", "carreta 14,6").',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['CONTAINER', 'VEHICLE'] } }, additionalProperties: false },
    },
    input: z.object({ kind: z.enum(['CONTAINER', 'VEHICLE']).optional() }),
    mutates: false,
    run: async (_ctx, i) => {
      const out: unknown[] = []
      if (i.kind !== 'VEHICLE')
        for (const c of await db.select().from(s.containerTypes).where(eq(s.containerTypes.active, true)))
          out.push({ kind: c.transportMode === 'AIR' ? 'ULD_AIR' : 'CONTAINER', code: c.code, name: c.name, innerMm: `${c.innerLengthMm}×${c.innerWidthMm}×${c.innerHeightMm}`, doorMm: `${c.doorWidthMm}×${c.doorHeightMm}`, tareKg: c.tareKg, maxPayloadKg: c.maxPayloadKg, maxGrossKg: c.maxGrossKg, dataStatus: c.verification })
      if (i.kind !== 'CONTAINER')
        for (const v of await db.select().from(s.vehicleTypes).where(cargoVehicleWhere()))
          out.push({ kind: 'VEHICLE', code: v.code, name: v.name, innerMm: `${v.innerLengthMm}×${v.innerWidthMm}×${v.innerHeightMm}`, doorMm: `${v.doorWidthMm}×${v.doorHeightMm}`, tareKg: v.tareKg, maxPayloadKg: v.maxPayloadKg, maxGrossKg: v.maxGrossKg, dataStatus: v.verification })
      return { equipment: out }
    },
  }),
  def({
    spec: {
      name: 'get_current_load',
      description: 'Resumo atual do rascunho da carga (equipamento, limites, totais, paletes por produto, litros, alertas). Use após alterações para relatar números reais.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    input: z.object({}),
    mutates: false,
    run: async (ctx) => summarizeLoad(ctx),
  }),
  def({
    spec: {
      name: 'set_equipment',
      description: 'Troca o equipamento (contêiner/veículo) do rascunho pelo código e reposiciona os paletes. Informa os que deixaram de caber.',
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'código exato, ex.: 40HC, 20GP' }, allow_stacking: { type: 'boolean' } }, required: ['code'], additionalProperties: false },
    },
    input: z.object({ code: z.string().min(1).max(40), allow_stacking: z.boolean().optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const c = await db.query.containerTypes.findFirst({ where: and(eq(s.containerTypes.code, i.code), eq(s.containerTypes.active, true)) })
      const v = c ? null : await db.query.vehicleTypes.findFirst({ where: and(eq(s.vehicleTypes.code, i.code), cargoVehicleWhere()) })
      if (!c && !v) return { error: `Equipamento ${i.code} não cadastrado. Use list_equipment.` }
      const before = ctx.draft.units.length
      const r = repack({ ...ctx.draft, space: c ? containerSpace(c) : vehicleSpace(v!) }, { allowStacking: i.allow_stacking })
      ctx.draft = r.doc
      return {
        equipment: ctx.draft.space.code,
        palletsBefore: before,
        palletsAfter: ctx.draft.units.length,
        didNotFit: r.unplaced.map((u) => ({ pallet: ctx.draft.pallets[u.palletKey]?.name, count: u.count })),
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'add_pallets',
      description:
        'Adiciona paletes de referência de um SKU ao rascunho, posicionados pelo motor (fundo → porta, respeitando porta, altura e payload). Informe quantity OU fill=true (completar todo o espaço/peso disponível). Retorna quantos couberam e o que limitou.',
      inputSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
          fill: { type: 'boolean', description: 'true = máximo possível' },
          allow_stacking: { type: 'boolean', description: 'padrão: sim (regra Pacifil: todos os paletes são empilháveis quando há altura útil). false = só piso.' },
        },
        required: ['sku'],
        additionalProperties: false,
      },
    },
    input: z.object({ sku, quantity: qty.optional(), fill: z.boolean().optional(), allow_stacking: z.boolean().optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      if (!i.quantity && !i.fill) return { error: 'Informe quantity ou fill=true.' }
      const p = await palletForSku(ctx, i.sku)
      if ('error' in p) return p
      const r = placePallets(ctx.draft, p.key, p.pallet, i.fill ? null : i.quantity!, { allowStacking: i.allow_stacking })
      ctx.draft = r.doc
      const more = maxAdditional(ctx.draft, p.key, p.pallet, { allowStacking: i.allow_stacking })
      return {
        sku: i.sku,
        palletSource: p.source,
        floorPattern: r.pattern ?? null,
        requested: i.fill ? 'máximo' : i.quantity,
        placed: r.placed,
        limitedBy: r.stopReason === 'done' ? null : STOP_TEXT[r.stopReason],
        stillFitsAfter: more.max,
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'compose_mix',
      description:
        'Monta uma mistura por PERCENTUAL DE PALETES (ex.: 60% / 40%) maximizando o total que cabe física e legalmente. clear_existing=true começa de uma carga vazia; false completa a carga atual. As porcentagens devem somar 100.',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', minItems: 1, items: { type: 'object', properties: { sku: { type: 'string' }, percentage: { type: 'number', exclusiveMinimum: 0, maximum: 100 } }, required: ['sku', 'percentage'], additionalProperties: false } },
          clear_existing: { type: 'boolean' },
          allow_stacking: { type: 'boolean' },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
    input: z.object({
      items: z.array(z.object({ sku, percentage: z.number().positive().max(100) })).min(1).max(8),
      clear_existing: z.boolean().optional(),
      allow_stacking: z.boolean().optional(),
    }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const total = i.items.reduce((t, x) => t + x.percentage, 0)
      if (Math.abs(total - 100) > 0.5) return { error: `As porcentagens somam ${total}%, não 100%.` }
      const resolved: { key: string; pallet: PalletDoc; share: number; sku: string }[] = []
      for (const it of i.items) {
        const p = await palletForSku(ctx, it.sku)
        if ('error' in p) return p
        resolved.push({ key: p.key, pallet: p.pallet, share: it.percentage / 100, sku: it.sku })
      }
      // começar do zero mantém as unidades travadas pelo usuário
      const base = i.clear_existing === false ? ctx.draft : removeUnits(ctx.draft, () => true, null).doc
      const r = composeMix(base, resolved, { allowStacking: i.allow_stacking })
      if (!r.total) return { error: 'Nenhuma combinação coube no equipamento com essas proporções.', limitedBy: STOP_TEXT[r.limitedBy] }
      ctx.draft = r.doc
      return {
        basis: 'percentual sobre o número de paletes',
        result: resolved.map((x, k) => ({ sku: x.sku, pallets: r.counts[k], actualPct: Math.round((r.counts[k] / r.total) * 1000) / 10 })),
        totalPallets: r.total,
        limitedBy: STOP_TEXT[r.limitedBy],
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'remove_pallets',
      description: 'Remove paletes do rascunho. sku opcional (todos os produtos se omitido); quantity opcional (todos se omitido); which: "last" = últimos adicionados (padrão), "door" = mais próximos da porta.',
      inputSchema: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, which: { type: 'string', enum: ['last', 'door'] } }, additionalProperties: false },
    },
    input: z.object({ sku: sku.optional(), quantity: qty.optional(), which: z.enum(['last', 'door']).optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const want = i.sku?.toUpperCase().replace(/\s+/g, '')
      const r = removeUnits(ctx.draft, (u) => !want || unitSkus(ctx.draft, u).some((x) => x.toUpperCase() === want), i.quantity ?? null, i.which ?? 'last')
      if (!r.removed.length) return { error: i.sku ? `Não há paletes de ${i.sku} (não travados) na carga.` : 'A carga não tem paletes removíveis.' }
      ctx.draft = r.doc
      return { removed: r.removed.length, load: compact(await summarizeLoad(ctx)) }
    },
  }),
  def({
    spec: {
      name: 'replace_product',
      description: 'Substitui paletes de um SKU por outro SKU (mesma quantidade, ou quantity). Reposiciona com o motor e informa se coube menos.',
      inputSchema: { type: 'object', properties: { from_sku: { type: 'string' }, to_sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['from_sku', 'to_sku'], additionalProperties: false },
    },
    input: z.object({ from_sku: sku, to_sku: sku, quantity: qty.optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const p = await palletForSku(ctx, i.to_sku)
      if ('error' in p) return p
      const want = i.from_sku.toUpperCase().replace(/\s+/g, '')
      const r = removeUnits(ctx.draft, (u) => unitSkus(ctx.draft, u).some((x) => x.toUpperCase() === want), i.quantity ?? null, 'last')
      if (!r.removed.length) return { error: `Não há paletes de ${i.from_sku} (não travados) na carga.` }
      const packed = repack(r.doc) // reorganiza antes de colocar o novo produto
      const add = placePallets(packed.doc, p.key, p.pallet, r.removed.length)
      ctx.draft = add.doc
      return {
        removed: r.removed.length,
        added: add.placed,
        limitedBy: add.stopReason === 'done' ? null : STOP_TEXT[add.stopReason],
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'remove_boxes',
      description:
        'Retira CAIXAS (ou UNIDADES de produto, unit="units") de UM palete já colocado, sem remover o palete; o palete passa a ter montagem própria (parcial) e NÃO volta a ser completado até o padrão. pallet: número do palete como aparece no 3D ("5" ou "P5"), "last" (último adicionado, padrão) ou "door" (mais perto da porta). sku opcional para escolher qual produto retirar. As caixas de cima saem primeiro.',
      inputSchema: {
        type: 'object',
        properties: {
          quantity: { type: 'integer', minimum: 1 },
          unit: { type: 'string', enum: ['boxes', 'units'], description: 'boxes = caixas (padrão); units = unidades de produto (convertidas pelas unidades por caixa)' },
          pallet: { type: 'string', description: 'número do palete no 3D ("5" ou "P5"), "last" ou "door"' },
          sku: { type: 'string' },
        },
        required: ['quantity'],
        additionalProperties: false,
      },
    },
    input: z.object({ quantity: qty, unit: z.enum(['boxes', 'units']).optional(), pallet: z.string().max(10).optional(), sku: sku.optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const pallets = ctx.draft.units.map((u, k) => ({ u, k })).filter((x) => x.u.kind === 'PALLET' && !x.u.locked)
      if (!pallets.length) return { error: 'A carga não tem paletes (não travados).' }
      const want = i.sku?.toUpperCase()
      const withSku = want ? pallets.filter((x) => unitSkus(ctx.draft, x.u).some((s) => s.toUpperCase() === want)) : pallets
      if (!withSku.length) return { error: `Nenhum palete com ${i.sku}.` }
      const which = (i.pallet ?? 'last').toLowerCase()
      let target = withSku[withSku.length - 1]
      if (which === 'door') {
        const geo = new Map(loadGeometries(ctx.draft).map((g) => [g.unit.id, g.box.min.x]))
        target = [...withSku].sort((a, b) => (geo.get(b.u.id) ?? 0) - (geo.get(a.u.id) ?? 0))[0]
      } else if (/^p?\s*\d+$/.test(which)) {
        const u = palletByNumber(ctx.draft, which)
        if (!u) return { error: `Não existe o palete ${which.toUpperCase()} na carga.` }
        if (u.locked) return { error: `O palete ${palletLabel(ctx.draft, u)} está travado.` }
        target = { u, k: ctx.draft.units.indexOf(u) }
      }
      // unidades de produto → caixas (só se fechar caixas inteiras)
      let boxes = i.quantity
      if (i.unit === 'units') {
        const p = ctx.draft.pallets[(target.u as Extract<LoadUnit, { kind: 'PALLET' }>).palletKey]
        const pack = Object.values(p?.packs ?? {}).find((k) => !i.sku || k.sku.toUpperCase() === i.sku.toUpperCase())
        const per = Math.max(1, pack?.unitsPerPackage ?? 1)
        if (i.quantity % per) return { error: `${pack?.sku ?? 'O produto'} vem em caixas de ${per} unidades: ${i.quantity} unidades não fecham caixas inteiras. Peça em caixas (ex.: ${Math.floor(i.quantity / per)} ou ${Math.ceil(i.quantity / per)} caixas).` }
        boxes = i.quantity / per
      }
      const r = removeBoxesFromPallet(ctx.draft, target.u.id, boxes, i.sku)
      if (r.error) return { error: r.error }
      ctx.draft = r.doc
      return { pallet: palletLabel(ctx.draft, target.u), removedBoxes: r.removed, boxesLeftOnPallet: r.remaining, note: 'Instrução manual aplicada: este palete NÃO volta a ser completado até o padrão.', load: compact(await summarizeLoad(ctx)) }
    },
  }),
  def({
    spec: {
      name: 'add_boxes_to_pallet',
      description:
        'Agrega CAIXAS (ou UNIDADES de produto, unit="units") a UM palete já colocado ("agregue 1 caixa ao palete 3"): por cima/ao lado das caixas do palete, só com apoio total, dentro da altura do equipamento, da capacidade do palete e do payload da carga. O palete passa a ter montagem própria (não altera os iguais). pallet: número do palete como no 3D ("3" ou "P3"). sku: padrão = o produto do próprio palete. Se não couber, nada muda e o motivo volta no erro.',
      inputSchema: {
        type: 'object',
        properties: {
          pallet: { type: 'string', description: 'número do palete no 3D ("3" ou "P3")' },
          quantity: { type: 'integer', minimum: 1 },
          unit: { type: 'string', enum: ['boxes', 'units'] },
          sku: { type: 'string', description: 'padrão: o produto do palete' },
        },
        required: ['pallet', 'quantity'],
        additionalProperties: false,
      },
    },
    input: z.object({ pallet: z.string().min(1).max(10), quantity: qty, unit: z.enum(['boxes', 'units']).optional(), sku: sku.optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const u = palletByNumber(ctx.draft, i.pallet)
      if (!u) return { error: `Não existe o palete ${i.pallet.toUpperCase()} na carga.` }
      const p = ctx.draft.pallets[u.palletKey]
      // produto: o pedido, ou o produto principal do palete (sem acompanhantes)
      let packId: string | undefined
      let pack: PackSnapshot | undefined
      if (i.sku) {
        const own = Object.entries(p.packs).find(([, k]) => k.sku.toUpperCase() === i.sku!.toUpperCase())
        // kit em caixa coletiva: agrega pela caixa individual (o kit vai 1 a 1)
        if (own) [packId, pack] = own[1].kitBox ? [packKeyOf(kitBaseOf(own[1])), kitBaseOf(own[1])] : own
        else {
          const e = await entryBySku(ctx, i.sku)
          if (!e?.pv) return { error: `Produto ${i.sku} não encontrado ou sem embalagem cadastrada.` }
          packId = `pv${e.pv.id}`
          pack = packSnapshot(e.pv, variantStub(e))
        }
      } else {
        const kits = new Set(Object.values(p.packs).flatMap((k) => (k.companions ?? []).map((c) => c.sku.toUpperCase())))
        const mains = Object.entries(p.packs).filter(([, k]) => !kits.has(k.sku.toUpperCase()))
        if (mains.length !== 1) return { error: `O palete ${palletLabel(ctx.draft, u)} tem mais de um produto: informe o sku.` }
        ;[packId, pack] = mains[0]
      }
      let boxes = i.quantity
      if (i.unit === 'units') {
        const per = Math.max(1, pack!.unitsPerPackage)
        if (i.quantity % per) return { error: `${pack!.sku} vem em caixas de ${per} unidades: ${i.quantity} unidades não fecham caixas inteiras.` }
        boxes = i.quantity / per
      }
      const r = addBoxesToPallet(ctx.draft, u.id, packId!, pack!, boxes)
      if (!r.added) return { error: r.error ?? 'Não foi possível agregar caixas a este palete.' }
      ctx.draft = r.doc
      return {
        pallet: palletLabel(ctx.draft, u),
        addedBoxes: r.added,
        boxesOnPallet: r.boxesOnPallet,
        ...(r.error ? { warning: r.error } : {}),
        note: 'Instrução manual aplicada: este palete fica com esta quantidade (o padrão do catálogo não é reaplicado).',
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'add_loose_boxes',
      description:
        'Adiciona CAIXAS SOLTAS de um SKU (fora de palete), posicionadas pelo motor: primeiro no piso livre e depois POR CIMA dos paletes/caixas (se o produto de baixo for empilhável), testando as orientações permitidas do produto e respeitando altura útil, porta e payload. Use quantity OU fill=true. floor_only=true = só no piso (padrão ao completar automaticamente: caixas por cima de um palete passariam do máximo por palete do catálogo). on_top_only=true só quando o usuário pedir para aproveitar o espaço de cima.',
      inputSchema: {
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, fill: { type: 'boolean' }, on_top_only: { type: 'boolean' }, floor_only: { type: 'boolean' } },
        required: ['sku'],
        additionalProperties: false,
      },
    },
    input: z.object({ sku, quantity: qty.optional(), fill: z.boolean().optional(), on_top_only: z.boolean().optional(), floor_only: z.boolean().optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      if (!i.quantity && !i.fill) return { error: 'Informe quantity ou fill=true.' }
      const e = await entryBySku(ctx, i.sku)
      if (!e) return { error: `Produto ${i.sku} não encontrado.` }
      if (!e.pv) return { error: `Produto ${e.sku} sem embalagem cadastrada (medidas/pesos).` }
      const pack = packSnapshot(e.pv, variantStub(e))
      const r = placeLooseBoxes(ctx.draft, `pv${e.pv.id}`, pack, i.fill ? null : i.quantity!, { onTopOnly: i.on_top_only, floorOnly: i.floor_only })
      ctx.draft = r.doc
      const placed = r.doc.units.filter((u) => r.unitIds.includes(u.id))
      return {
        sku: e.sku,
        requested: i.fill ? 'máximo' : i.quantity,
        placed: r.placed,
        onTop: placed.filter((u) => u.pos.z > 0).length,
        onFloor: placed.filter((u) => u.pos.z === 0).length,
        limitedBy: r.stopReason === 'done' ? null : STOP_TEXT[r.stopReason],
        missingData: missingData(e),
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'balance_load',
      description:
        'Distribui o PESO (motor determinístico "Distribuir peso"). NORTE = frente (cabine), SUL = traseira (sobre os eixos traseiros); OESTE = lado do motorista, LESTE = lado do acompanhante. Regra Pacifil, por prioridade: 1) limites do equipamento e por eixo; 2) o mais uniforme possível (frente × trás e oeste × leste); 3) havendo diferença, 1–2 p.p. a mais na metade TRASEIRA (traseira 50,5–51%, ex.: 49% frente / 51% trás); 4) nunca mais peso na frente. Só reorganiza as posições dos paletes (nunca muda produtos nem quantidades). spread=true usa o espaço livre até a porta: primeiro desloca o BLOCO inteiro (paletes continuam travados entre si; o vão fica só na frente, para calço/airbag) e só abre vãos entre paletes se isso não bastar. rear_target_pct (48–53) só quando o usuário pedir explicitamente outra proporção. Devolve frente/trás e quadrantes antes/depois e meetsRules.',
      inputSchema: {
        type: 'object',
        properties: { spread: { type: 'boolean' }, rear_target_pct: { type: 'number', minimum: 48, maximum: 53 } },
        additionalProperties: false,
      },
    },
    input: z.object({ spread: z.boolean().optional(), rear_target_pct: z.number().min(48).max(53).optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const base = DEFAULT_QUADRANT_RULES
      // proporção pedida explicitamente pelo usuário: faixa de ±0,25 p.p. em torno dela
      const t = i.rear_target_pct
      const rules = t != null ? { rearMinPct: Math.min(base.rearMinPct, t - 0.25), rearIdealMinPct: t - 0.25, rearMaxPct: t + 0.25, rearTargetPct: t, rearWarnPct: Math.max(base.rearWarnPct, t + 1) } : base
      const r = balanceWeight(ctx.draft, { spread: i.spread, rules })
      if (!r.movable) return { error: 'Nenhum palete pode mudar de posição (travados, empilhados ou com carga em cima).' }
      const changed = r.doc !== ctx.draft
      ctx.draft = r.doc
      const r1 = (v: number) => Math.round(v * 10) / 10
      const f = (m: typeof r.before) => {
        const s = m.quadrants.shares
        return { frontPct: r1(s.northPct), rearPct: r1(s.southPct), NE: r1(s.pct.NE), NO: r1(s.pct.NO), SE: r1(s.pct.SE), SO: r1(s.pct.SO) }
      }
      return {
        changed,
        meetsRules: r.meetsRules,
        reason: r.reason ?? null,
        rule: `traseira ${rules.rearIdealMinPct}–${rules.rearMaxPct}% (alvo ${rules.rearTargetPct}%), nunca mais peso na frente`,
        physicalIssuesAfter: r.physicalIssuesAfter,
        spread: r.spread,
        before: f(r.before),
        after: f(r.after),
        load: compact(await summarizeLoad(ctx)),
      }
    },
  }),
  def({
    spec: {
      name: 'optimize_mixed_pallets',
      description:
        'PALETES MISTOS: recebe o PEDIDO (unidades por SKU) e o motor determinístico monta a menor quantidade de paletes misturando produtos/medidas, com as caixas reais (medidas, pesos, orientações), altura máxima do transporte e capacidade do palete. Devolve cada palete (produtos e unidades, peso, altura, ocupação) e a conferência pedido × paletes. mode: FCL (contêiner, altura = mín(interna, porta)), LCL, AIR, ROAD, PALLETS_ONLY (só paletes). Em AIR/LCL/PALLETS_ONLY informe max_height_mm (depende do operador; se o usuário não disser, pergunte — exceto AIR com ULD já escolhida na carga). apply=true coloca os paletes na carga aberta (não em PALLETS_ONLY).',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: { type: 'object', properties: { sku: { type: 'string' }, units: { type: 'integer', minimum: 1 } }, required: ['sku', 'units'], additionalProperties: false },
          },
          mode: { type: 'string', enum: ['FCL', 'LCL', 'AIR', 'ROAD', 'PALLETS_ONLY'] },
          max_height_mm: { type: 'integer', minimum: 300, maximum: 4000 },
          max_kg_per_pallet: { type: 'number', minimum: 1 },
          destination: { type: 'string', description: 'país de destino, se diferente do envio da carga' },
          apply: { type: 'boolean', description: 'padrão: true (exceto PALLETS_ONLY)' },
        },
        required: ['lines', 'mode'],
        additionalProperties: false,
      },
    },
    input: z.object({
      lines: z.array(z.object({ sku, units: z.number().int().min(1).max(100000) })).min(1).max(40),
      mode: z.enum(['FCL', 'LCL', 'AIR', 'ROAD', 'PALLETS_ONLY']),
      max_height_mm: z.number().int().min(300).max(4000).optional(),
      max_kg_per_pallet: z.number().positive().optional(),
      destination: z.string().max(60).optional(),
      apply: z.boolean().optional(),
    }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const built = await buildMixedPallets(ctx, i.lines, i.mode, { maxHeightMm: i.max_height_mm, maxKgPerPallet: i.max_kg_per_pallet, destination: i.destination })
      if ('error' in built) return built
      const { r, notes, H } = built
      let applied: { placed: number; failed: number[]; balanced: boolean } | null = null
      if ((i.apply ?? true) && (i.mode !== 'PALLETS_ONLY' || ctx.draft.space.kind === 'NONE') && r.pallets.length) {
        const m = placeMixedPalletsInLoad(ctx.draft, r.pallets.map((p) => p.doc), `mx${Date.now().toString(36)}`)
        ctx.draft = m.doc
        applied = { placed: m.placed, failed: m.failed, balanced: m.balanced }
      }
      const r1 = (v: number) => Math.round(v * 10) / 10
      return {
        mode: i.mode,
        maxHeightMm: H,
        pallets: r.pallets.map((p, k) => ({
          pallet: k + 1,
          type: `${p.doc.palletType.code} ${p.doc.palletType.dims.l}×${p.doc.palletType.dims.w}`,
          contents: p.lines.map((l) => `${l.sku}: ${l.units} un.`).join(', '),
          grossKg: Math.round(p.grossKg),
          heightM: Math.round(p.heightMm) / 1000,
          occupancyPct: Math.round(p.volumeUtilPct),
          critical: p.issues.filter((x) => x.severity === 'CRITICAL').map((x) => x.message),
        })),
        totals: { pallets: r.totals.pallets, floorPositions: r.positions, grossKg: Math.round(r.totals.grossKg), cbm: r1(r.totals.cbm), units: r.totals.units },
        orderCheck: r.check.map((c) => `${c.sku} ${c.placed}/${c.requested}${c.ok ? ' ok' : ''}`).join(' · '),
        allQuantitiesMatch: r.check.every((c) => c.ok),
        unplaced: r.unplaced,
        notes,
        appliedToLoad: applied,
        load: applied ? compact(await summarizeLoad(ctx)) : undefined,
      }
    },
  }),
  def({
    spec: {
      name: 'split_into_units',
      description:
        'PEDIDO QUE NÃO CABE NUM SÓ EQUIPAMENTO: divide o pedido COMPLETO em várias unidades (contêineres/veículos) pelo motor: mínimo de unidades, a 1ª o mais cheia possível, depois a 2ª…, remanente concentrado na ÚLTIMA (nunca reparte por igual), preferindo produtos inteiros por unidade. ' +
        'Informe o pedido completo: lines (unidades por SKU → paletes mistos) OU pallets (paletes padrão por SKU); sem nenhum dos dois, divide a carga atual. equipment = código (padrão: o do rascunho). ' +
        'O rascunho vira a unidade 1; as demais ficam na proposta (o usuário aplica e o sistema grava todas juntas). Devolve cada unidade (paletes, kg, %), o que não coube, o espaço livre na última e se um equipamento menor serviria para o remanente.',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            maxItems: 40,
            items: { type: 'object', properties: { sku: { type: 'string' }, units: { type: 'integer', minimum: 1 } }, required: ['sku', 'units'], additionalProperties: false },
          },
          pallets: {
            type: 'array',
            maxItems: 40,
            items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['sku', 'quantity'], additionalProperties: false },
          },
          equipment: { type: 'string', description: 'código exato (ex.: 40HC); padrão: equipamento atual' },
          max_units: { type: 'integer', minimum: 2, maximum: 10 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      lines: z.array(z.object({ sku, units: z.number().int().min(1).max(100000) })).max(40).optional(),
      pallets: z.array(z.object({ sku, quantity: z.number().int().min(1).max(2000) })).max(40).optional(),
      equipment: z.string().min(1).max(40).optional(),
      max_units: z.number().int().min(2).max(10).optional(),
    }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      let space = ctx.draft.space
      if (i.equipment) {
        const c = await db.query.containerTypes.findFirst({ where: and(eq(s.containerTypes.code, i.equipment), eq(s.containerTypes.active, true)) })
        const v = c ? null : await db.query.vehicleTypes.findFirst({ where: and(eq(s.vehicleTypes.code, i.equipment), cargoVehicleWhere()) })
        if (!c && !v) return { error: `Equipamento ${i.equipment} não cadastrado. Use list_equipment.` }
        space = c ? containerSpace(c) : vehicleSpace(v!)
      }
      const base: LoadDoc = { ...ctx.draft, space }
      let groups: PalletGroup[] = []
      let loose: LooseGroup[] = []
      const notes: string[] = []
      if (i.lines?.length) {
        const mode: MixedMode = space.transport === 'AIR' ? 'AIR' : space.kind === 'VEHICLE' ? 'ROAD' : 'FCL'
        const built = await buildMixedPallets({ ...ctx, draft: base }, i.lines, mode)
        if ('error' in built) return built
        notes.push(...built.notes)
        const stamp = `mx${Date.now().toString(36)}`
        groups = built.r.pallets.map((p, k) => ({ key: `${stamp}_${k + 1}`, pallet: { ...p.doc, name: `Misto ${k + 1} · ${p.lines.map((l) => l.sku).join('+')}` }, count: 1 }))
      } else if (i.pallets?.length) {
        for (const l of i.pallets) {
          // altura do equipamento NOVO (ex.: 10 paletes de HF 5K num 20' Dry → 34 un. + kits, não a REF de 36)
          const p = await palletForSku({ ...ctx, draft: base }, l.sku)
          if ('error' in p) return p
          const have = groups.find((g) => g.key === p.key)
          if (have) have.count += l.quantity
          else groups.push({ key: p.key, pallet: p.pallet, count: l.quantity })
        }
      } else {
        ;({ pallets: groups, loose } = groupsOfDoc(ctx.draft))
        if (!groups.length && !loose.length) return { error: 'A carga atual está vazia: informe o pedido (lines ou pallets).' }
      }
      const plan = splitIntoUnits(base, groups, loose, { maxUnits: i.max_units ?? 10, alternatives: await sameModeSpaces(base) })
      if (!plan.units.length) return { error: 'Nada coube no equipamento (porta, altura ou peso de cada palete).', didNotFit: plan.unplaced }
      ctx.draft = plan.units[0].doc
      ctx.extraUnits = plan.units.slice(1).map((u) => u.doc)
      ctx.unitNotes = planNotes(plan)
      const last = plan.units[plan.units.length - 1].doc
      const free = freeCapacity(last, groups)
      return {
        equipment: space.code,
        unitCount: plan.units.length,
        units: await Promise.all(
          plan.units.map(async (u, k) => {
            const sm = compact(await summarizeLoad(ctx, u.doc))
            return { unit: k + 1, pallets: u.groups.map((g) => `${g.count} × ${g.name}`), looseBoxes: u.loose.map((l) => `${l.count} × ${l.sku}`), payloadKg: sm.payloadKg, payloadPct: sm.payloadPct, floorPct: sm.floorPct, critical: sm.critical }
          }),
        ),
        didNotFit: plan.unplaced,
        lastUnitFree: { payloadFreeKg: free.payloadFreeKg == null ? null : Math.round(free.payloadFreeKg), stillFitsPallets: free.morePallets.filter((m) => m.count > 0).slice(0, 6) },
        smallerEquipmentForLast: plan.smallerLast ? { code: plan.smallerLast.code, name: plan.smallerLast.name } : null,
        notes,
      }
    },
  }),
  def({
    spec: { name: 'repack_load', description: 'Reorganiza todos os paletes não travados do zero (compactar / "tentar melhorar"). Mantém produtos e quantidades.', inputSchema: { type: 'object', properties: { allow_stacking: { type: 'boolean' } }, additionalProperties: false } },
    input: z.object({ allow_stacking: z.boolean().optional() }),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx, i) => {
      const r = repack(ctx.draft, { allowStacking: i.allow_stacking })
      ctx.draft = r.doc
      return { didNotFit: r.unplaced, load: compact(await summarizeLoad(ctx)) }
    },
  }),
  def({
    spec: { name: 'clear_load', description: 'Esvazia o rascunho (remove todas as unidades não travadas).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    input: z.object({}),
    permission: 'editPlans',
    mutates: true,
    run: async (ctx) => {
      ctx.draft = removeUnits(ctx.draft, () => true, null).doc
      return { load: compact(await summarizeLoad(ctx)) }
    },
  }),
] as const

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec)

/** Executa uma tool com validação de entrada e autorização pela mesma regra de papéis da UI. */
const NONE_BLOCKED = new Set(['list_equipment', 'set_equipment', 'balance_load', 'split_into_units', 'compose_mix', 'repack_load'])

export async function executeTool(ctx: ToolContext, name: string, raw: unknown): Promise<{ ok: boolean; result: unknown; mutated: boolean }> {
  const t = TOOLS.find((x) => x.spec.name === name)
  if (!t) return { ok: false, result: { error: `Ferramenta desconhecida: ${name}` }, mutated: false }
  if (t.permission && !can[t.permission](ctx.user.role)) return { ok: false, result: { error: 'Seu usuário não tem permissão para esta ação.' }, mutated: false }
  const parsed = t.input.safeParse(raw ?? {})
  if (!parsed.success) return { ok: false, result: { error: 'Parâmetros inválidos', details: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) }, mutated: false }
  // envio SEM equipamento (piso virtual): sem contêiner/veículo, eixos ou divisão em unidades
  const isNone = ctx.draft.space.kind === 'NONE'
  if (isNone && raw && typeof raw === 'object' && (raw as { fill?: unknown }).fill === true)
    return { ok: false, result: { error: 'Em envio sem equipamento não existe "completar o espaço": informe a quantidade (quantity).' }, mutated: false }
  if (isNone && NONE_BLOCKED.has(name)) return { ok: false, result: { error: 'Não se aplica a envio sem equipamento (LCL, aéreo carga solta, só paletes, courier). Use optimize_mixed_pallets (apply=true) ou add_loose_boxes.' }, mutated: false }
  const before = ctx.draft
  // o motor posiciona num piso longo; depois o piso encolhe ao conteúdo
  const work = withNoneWorkArea(ctx.draft)
  ctx.draft = work
  let result: Record<string, unknown>
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = (await t.run(ctx, parsed.data as any)) as Record<string, unknown>
  } finally {
    ctx.draft = ctx.draft === work ? before : isNone ? fitNone(ctx.draft) : ctx.draft
  }
  const isErr = Boolean(result && typeof result === 'object' && 'error' in result)
  if (t.mutates && ctx.draft !== before && !isErr) {
    await catalog(ctx)
    const added = await ensureCompanions(ctx)
    if (added.length) result.companionsAdded = added.map((a) => ({ ...a, rule: 'acompanhante obrigatório (ex.: 1 kit por Hydroforce)' }))
  }
  return { ok: !isErr, result, mutated: t.mutates && ctx.draft !== before }
}
