import 'server-only'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import { commissionOutsideUsual, COMMISSION_USUAL, PricingConfig, quotePrice, roundUpUsd, twinsWithSnapshot } from '@/domain/exportPricing'
import { commissionAgentId, FrozenPricing, orderValue, orderValueFromPrices, PriceResolution, proformaTotals, quoteSignatureInput, QuoteSnapshotLine, skuQuantities } from '@/domain/pricing'
import { PaymentTerms, paymentTermsText, TermsLang } from '@/domain/paymentTerms'
import type { LoadDoc } from '@/domain/types'
import { countryCode } from './countries'
import type { IssuedQuote } from '@/components/quotes/QuoteView'
import { loadPricingConfig } from './exportPricing'

/** Dados comuns para resolver preços (configuração, família/marca dos SKUs, nomes das famílias, agente ativo). */
async function pricingContext(skus: string[], agentId: number | null | undefined) {
  const cfg = await loadPricingConfig()
  const variants = skus.length
    ? await db
        .select({ sku: schema.productVariants.sku, brand: schema.productVariants.brand, familyId: schema.products.familyId })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(inArray(schema.productVariants.sku, skus))
    : []
  const agentRow = agentId ? await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }) : null
  // agente inativo não aplica comissão (nem aparece como "via agente")
  const agent = agentRow?.active ? agentRow : null
  const families = new Map((await db.select({ id: schema.productFamilies.id, name: schema.productFamilies.name }).from(schema.productFamilies)).map((f) => [f.id, f.name]))
  return { cfg, variants, agent, families }
}

/**
 * Preço de UM produto com os fatores usados (registro histórico): família/regra, USD/kg, fixo, marca,
 * recargo CIF, comissão. Mesmo caminho para cargas e para paletes mistos/courier.
 */
function resolveLinePrice(
  ctx: { cfg: PricingConfig; variants: { sku: string; brand: string | null; familyId: number }[]; agent: { id: number; name: string } | null; families: Map<number, string> },
  sku: string,
  netKg: number,
  cc: string | null,
  incoterm: string | null,
): { line: PriceResolution; category: string | null } {
  const v = ctx.variants.find((x) => x.sku.toUpperCase() === sku.toUpperCase())
  if (!v) return { line: { unitUsd: null, reason: 'produto não encontrado no catálogo' }, category: null }
  // Incoterm: CIF soma o recargo por kg
  const r = quotePrice(ctx.cfg, { sku, familyId: v.familyId, brand: v.brand, netKg }, cc, { agentId: ctx.agent?.id ?? null, incoterm })
  const category = r.category?.name ?? null
  if (!r.ok) return { line: { unitUsd: null, reason: r.reason }, category }
  const c = r.commission
  if (c && c.pct == null) return { line: { unitUsd: null, reason: `agente ${ctx.agent?.name ?? ''}: ${c.warning ?? 'sem % de comissão'}`.trim() }, category }
  const baseUnitUsd = 'baseUnitUsd' in r ? r.baseUnitUsd ?? r.unitUsd : r.unitUsd
  return {
    category,
    line: {
      unitUsd: r.unitUsd,
      baseUnitUsd,
      commissionPct: c?.pct ?? null,
      commissionUnitUsd: c?.commissionUsd ?? null,
      warning: c?.warning ?? null,
      factors: {
        familyId: v.familyId,
        family: ctx.families.get(v.familyId) ?? `família ${v.familyId}`,
        method: r.method,
        category,
        usdPerKg: r.usdPerKg,
        fixedUsdPerUnit: r.fixedUsdPerUnit,
        refFamily: r.base ? ctx.families.get(r.base.familyId) ?? null : null,
        markupPct: r.base?.markupPct ?? null,
        brand: v.brand ?? null,
        brandAdjustPct: r.brandAdjustPct ?? null,
        netKgUnit: Math.round((r.priceAs ? r.priceAs.netKg : netKg) * 1000) / 1000,
        priceAsSku: r.priceAs?.sku ?? null,
        priceBand: r.band ? `${r.band.label}${r.band.nearest ? ` (diâmetro ${String(r.band.diameterFt).replace('.', ',')} pés, faixa mais próxima)` : ''}` : null,
        baseUnitUsd,
        incoterm,
        cifUsdPerKg: r.cifUsdPerKg ?? null,
        cifSurchargeUsd: r.cifSurchargeUsd ?? null,
      },
    },
  }
}

/**
 * Preços da carga pelo módulo "Preços de exportação": país de destino do pedido → categoria; família
 * e marca do catálogo; peso líquido do snapshot da carga (o mesmo das quantidades); agente do cliente
 * (comissão incluída no preço, % do preço final); Incoterm (CIF: recargo por kg). Mercado interno: sem preço.
 */
/** agentOf: o agente DA CARGA (load_plan.agent_id) */
export async function computeLoadPricing(doc: LoadDoc, shipment: { destinationCountry: string; area: string; incoterm?: string | null } | null | undefined, agentOf: { agentId: number | null } | null | undefined): Promise<FrozenPricing> {
  const qty = skuQuantities(doc)
  const ctx0 = await pricingContext([...qty.keys()], agentOf?.agentId)
  // 3 m: se o Hidrosilo 2 m equivalente está nesta carga, o peso do snapshot dele (mesmo preço do 2 m na Proforma)
  const snapKg = new Map([...qty].map(([s, q]) => [s.toUpperCase(), q.pack.netKg / Math.max(1, q.pack.unitsPerPackage)]))
  const ctx = { ...ctx0, cfg: { ...ctx0.cfg, priceTwin: twinsWithSnapshot(ctx0.cfg.priceTwin, snapKg) } }
  const cc = countryCode(shipment?.destinationCountry) ?? null
  const lines: Record<string, PriceResolution> = {}
  let category: string | null = null
  for (const [sku, q] of qty) {
    if (shipment?.area !== 'EXPORT') {
      lines[sku] = { unitUsd: null, reason: 'preços de mercado interno ainda não definidos' }
      continue
    }
    // peso líquido por unidade de venda, do snapshot da carga
    const r = resolveLinePrice(ctx, sku, q.pack.netKg / Math.max(1, q.pack.unitsPerPackage), cc, shipment?.incoterm ?? null)
    if (r.category) category = r.category
    lines[sku] = r.line
  }
  return { computedAt: new Date().toISOString(), country: cc, category, agent: ctx.agent ? { id: ctx.agent.id, name: ctx.agent.name } : null, lines }
}

/**
 * Valor da versão da carga:
 *   - não aprovada → calculado agora com a tabela vigente;
 *   - aprovada (ou substituída) com preços congelados → os congelados (não mudam com a tabela);
 *   - aprovada antes do módulo (sem congelado) → os preços antigos do snapshot da carga.
 */
export async function planValue(data: { v: { status: string; document: LoadDoc; pricing: FrozenPricing | null }; shipment?: { destinationCountry: string; area: string; incoterm?: string | null } | null; plan?: { agentId: number | null } | null }) {
  const doc = data.v.document
  const approved = data.v.status === 'APPROVED' || data.v.status === 'SUPERSEDED'
  if (approved && !data.v.pricing) return { source: 'legacy' as const, pricing: null, value: { ...orderValue(doc), commissionUsd: 0, reasons: {} as Record<string, string> } }
  const pricing = approved ? data.v.pricing! : await computeLoadPricing(doc, data.shipment, data.plan)
  return { source: approved ? ('frozen' as const) : ('live' as const), pricing, value: orderValueFromPrices(doc, pricing.lines) }
}

const termsLang = (lang: string) => (lang === 'es' || lang === 'en' ? lang : 'pt') as TermsLang

/**
 * Grava (ou reemite) a cotação. Assinatura = conteúdo das linhas + agente + país + Incoterm + frete +
 * seguro + condições: tudo igual → só soma uma emissão e atualiza o status (a primeira data e quem emitiu ficam).
 */
async function upsertQuote(values: typeof schema.priceQuotes.$inferInsert, header: unknown[], userId: number) {
  const signature = createHash('sha256')
    .update(`${values.source}|${quoteSignatureInput(values.lines)}|${JSON.stringify(header)}`)
    .digest('hex')
  const now = new Date()
  const [row] = await db
    .insert(schema.priceQuotes)
    .values({ ...values, signature, firstIssuedAt: now, lastIssuedAt: now, createdBy: userId, lastIssuedBy: userId })
    .onConflictDoUpdate({
      target: [schema.priceQuotes.loadPlanVersionId, schema.priceQuotes.signature],
      // reemissão: data/contador/quem, STATUS da versão na última emissão (rascunho → aprovada) e dados
      // descritivos atuais; primeira data e primeiro emissor ficam
      set: { status: values.status, lastIssuedAt: now, lastIssuedBy: userId, issueCount: sql`${schema.priceQuotes.issueCount} + 1`, lang: values.lang, planName: values.planName, orderRef: values.orderRef, customerId: values.customerId, customerName: values.customerName, transportCompany: values.transportCompany },
    })
    .returning({ id: schema.priceQuotes.id })
  return row?.id ?? null
}

/**
 * Registra a COTAÇÃO EMITIDA (PDF do pedido gerado para o cliente) com os preços e os fatores usados.
 * Falha aqui nunca impede o PDF (o chamador ignora o erro).
 */
export async function recordIssuedQuote(
  data: {
    plan: { id: number; name: string; freightUsd: number | null; insuranceUsd: number | null; paymentTerms: PaymentTerms | null; transportCompanyId: number | null }
    v: { id: number; version: number; status: string }
    shipment?: { area: string; orderRef: string | null; incoterm: string } | null
    customer?: { id: number; name: string } | null
  },
  pv: Awaited<ReturnType<typeof planValue>>,
  userId: number,
  lang: string,
) {
  if (data.shipment?.area !== 'EXPORT') return null
  const names = new Map<string, string>()
  const doc = (data.v as { document?: LoadDoc }).document
  if (doc) for (const [sku, q] of skuQuantities(doc)) names.set(sku, q.pack.name)
  const lines: QuoteSnapshotLine[] = pv.value.lines.map((l) => {
    const p = pv.pricing?.lines[l.sku]
    return {
      sku: l.sku,
      name: names.get(l.sku) ?? l.sku,
      units: l.quantity,
      unitUsd: l.unitPrice,
      amount: l.amount,
      reason: l.unitPrice == null ? (pv.value.reasons[l.sku] ?? 'sem preço') : null,
      commissionPct: p?.commissionPct ?? null,
      commissionUnitUsd: p?.commissionUnitUsd ?? null,
      factors: p?.factors ?? null,
    }
  })
  const totals = proformaTotals(pv.value.totals.USD ?? null, data.plan.freightUsd, data.plan.insuranceUsd)
  const tc = data.plan.transportCompanyId ? await db.query.transportCompanies.findFirst({ where: eq(schema.transportCompanies.id, data.plan.transportCompanyId) }) : null
  const incoterm = data.shipment?.incoterm ?? null
  const agent = pv.pricing?.agent ?? null
  const country = pv.pricing?.country ?? null
  return upsertQuote(
    {
      origin: 'load',
      loadPlanId: data.plan.id,
      loadPlanVersionId: data.v.id,
      version: data.v.version,
      planName: data.plan.name,
      customerId: data.customer?.id ?? null,
      customerName: data.customer?.name ?? null,
      orderRef: data.shipment?.orderRef ?? null,
      status: data.v.status,
      source: pv.source,
      country,
      category: pv.pricing?.category ?? null,
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      totalUsd: pv.value.totals.USD ?? null,
      incoterm,
      freightUsd: totals.freightUsd,
      insuranceUsd: totals.insuranceUsd,
      grandTotalUsd: totals.totalUsd,
      paymentTerms: paymentTermsText(data.plan.paymentTerms, termsLang(lang)),
      transportCompany: tc ? `${tc.code} — ${tc.name}` : null,
      commissionUsd: pv.value.commissionUsd || null,
      lines,
      signature: '',
      lang,
    },
    [agent?.id ?? null, country, incoterm, totals.freightUsd, totals.insuranceUsd, data.plan.paymentTerms ?? null],
    userId,
  )
}

/**
 * Cotação emitida de PALETES MISTOS / COURIER (PDF gerado sem carga): os preços são RECALCULADOS no
 * servidor (mesmas regras), a partir dos SKUs e unidades, do destino, do agente e do Incoterm.
 */
export async function recordPlannerQuote(o: { origin: 'mixed' | 'courier'; reference: string | null; destination: string; agentId: number | null; incoterm: string | null; lines: { sku: string; units: number }[]; lang: string; userId: number }) {
  const units = new Map<string, number>()
  for (const l of o.lines) if (l.units > 0) units.set(l.sku, (units.get(l.sku) ?? 0) + l.units)
  if (!units.size) return null
  const skus = [...units.keys()]
  const ctx = await pricingContext(skus, o.agentId)
  // peso líquido por unidade e nome: embalagem VIGENTE do catálogo
  const packs = await db
    .select({ sku: schema.productVariants.sku, name: schema.productVariants.name, netKg: schema.packagingVersions.netKg, upp: schema.packagingVersions.unitsPerPackage, version: schema.packagingVersions.version })
    .from(schema.packagingVersions)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.packagingVersions.variantId))
    .where(inArray(schema.productVariants.sku, skus))
  const cur = new Map<string, (typeof packs)[number]>()
  for (const p of packs) if (!cur.get(p.sku) || p.version > cur.get(p.sku)!.version) cur.set(p.sku, p)
  const cc = countryCode(o.destination) ?? null
  let category: string | null = null
  let goods = 0
  let commission = 0
  const lines: QuoteSnapshotLine[] = skus.map((sku) => {
    const p = cur.get(sku)
    const n = units.get(sku)!
    if (!p) return { sku, name: sku, units: n, unitUsd: null, amount: null, reason: 'produto não encontrado no catálogo' }
    const r = resolveLinePrice(ctx, sku, p.netKg / Math.max(1, p.upp), cc, o.incoterm)
    if (r.category) category = r.category
    const amount = r.line.unitUsd != null ? Math.round(r.line.unitUsd * n * 100) / 100 : null
    if (amount != null) goods += amount
    commission += (r.line.commissionUnitUsd ?? 0) * n
    return { sku, name: p.name, units: n, unitUsd: r.line.unitUsd, amount, reason: r.line.unitUsd == null ? r.line.reason ?? 'sem preço' : null, commissionPct: r.line.commissionPct ?? null, commissionUnitUsd: r.line.commissionUnitUsd ?? null, factors: r.line.factors ?? null }
  })
  const goodsUsd = lines.some((l) => l.amount != null) ? Math.round(goods * 100) / 100 : null
  return upsertQuote(
    {
      origin: o.origin,
      loadPlanId: null,
      loadPlanVersionId: null,
      version: null,
      reference: o.reference,
      planName: o.reference || (o.origin === 'courier' ? 'Courier' : 'Paletes mistos'),
      status: 'PLANNER',
      source: 'live',
      country: cc,
      category,
      agentId: ctx.agent?.id ?? null,
      agentName: ctx.agent?.name ?? null,
      totalUsd: goodsUsd,
      incoterm: o.incoterm,
      grandTotalUsd: goodsUsd,
      commissionUsd: Math.round(commission * 100) / 100 || null,
      lines,
      signature: '',
      lang: o.lang,
    },
    [o.origin, o.reference ?? null, ctx.agent?.id ?? null, cc, o.incoterm],
    o.userId,
  )
}

/** Cotações emitidas (mais recentes primeiro): de uma carga, ou todas (consulta em Preços de exportação). */
export async function issuedQuotes(o: { loadPlanId?: number; limit?: number } = {}) {
  return db
    .select()
    .from(schema.priceQuotes)
    .where(o.loadPlanId != null ? and(eq(schema.priceQuotes.loadPlanId, o.loadPlanId)) : undefined)
    .orderBy(desc(schema.priceQuotes.lastIssuedAt))
    .limit(o.limit ?? 500)
}

/** Cotações emitidas prontas para exibir (datas em ISO, quem emitiu, se a carga ainda existe). */
export async function issuedQuotesView(o: { loadPlanId?: number; limit?: number } = {}): Promise<IssuedQuote[]> {
  const rows = await issuedQuotes(o)
  const ids = [...new Set(rows.flatMap((r) => [r.lastIssuedBy, r.createdBy]).filter((x): x is number => x != null))]
  const users = ids.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids)) : []
  const uname = new Map(users.map((u) => [u.id, u.name]))
  const planIds = [...new Set(rows.map((r) => r.loadPlanId).filter((x): x is number => x != null))]
  const existing = new Set(planIds.length ? (await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(inArray(schema.loadPlans.id, planIds))).map((p) => p.id) : [])
  return rows.map((r) => ({
    id: r.id,
    origin: r.origin,
    loadPlanId: r.loadPlanId,
    loadExists: r.loadPlanId != null && existing.has(r.loadPlanId),
    version: r.version,
    reference: r.reference,
    planName: r.planName,
    customerName: r.customerName,
    orderRef: r.orderRef,
    status: r.status,
    source: r.source,
    country: r.country,
    category: r.category,
    agentName: r.agentName,
    totalUsd: r.totalUsd,
    incoterm: r.incoterm,
    freightUsd: r.freightUsd,
    insuranceUsd: r.insuranceUsd,
    grandTotalUsd: r.grandTotalUsd ?? r.totalUsd,
    paymentTerms: r.paymentTerms,
    transportCompany: r.transportCompany,
    commissionUsd: r.commissionUsd,
    lines: r.lines,
    firstIssuedAt: r.firstIssuedAt.toISOString(),
    lastIssuedAt: r.lastIssuedAt.toISOString(),
    issueCount: r.issueCount,
    firstIssuedBy: r.createdBy != null ? uname.get(r.createdBy) ?? null : null,
    issuedBy: uname.get(r.lastIssuedBy ?? r.createdBy ?? -1) ?? null,
  }))
}

/**
 * Agente ou % de comissão trocados DEPOIS da aprovação: re-congela os preços da versão aprovada com a
 * comissão nova, sobre a MESMA base congelada (lista + marca + CIF). Sem agente: preço sem comissão.
 * Agente inativo conta como sem agente, salvo se já era o agente congelado (ver commissionAgentId).
 * Devolve quantas versões foram re-congeladas.
 */
export async function refreezeCommission(planIds: number[]): Promise<number> {
  if (!planIds.length) return 0
  const versions = await db
    .select({ v: schema.loadPlanVersions, agentId: schema.loadPlans.agentId })
    .from(schema.loadPlanVersions)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.loadPlanVersions.loadPlanId))
    .where(and(inArray(schema.loadPlanVersions.loadPlanId, planIds), eq(schema.loadPlanVersions.status, 'APPROVED')))
  let n = 0
  for (const { v, agentId } of versions) {
    const fp = v.pricing
    if (!fp) continue
    const agentRow = agentId ? await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }) : null
    // agente inativo não aplica comissão nova (como no cálculo ao vivo); a já congelada com ele fica
    const agent = agentRow && commissionAgentId(agentRow, fp.agent?.id) != null ? agentRow : null
    const rates = agent ? await db.select().from(schema.commissionRates).where(eq(schema.commissionRates.agentId, agent.id)) : []
    const pctOf = new Map(rates.map((r) => [r.familyId, r.pct]))
    const lines: Record<string, PriceResolution> = {}
    for (const [sku, r] of Object.entries(fp.lines)) {
      const base = r.baseUnitUsd ?? null
      if (base == null || !r.factors || r.factors.method === 'INCLUDED') {
        lines[sku] = r
        continue
      }
      if (!agent) {
        lines[sku] = { ...r, unitUsd: roundUpUsd(base), commissionPct: null, commissionUnitUsd: null, warning: null, reason: null }
        continue
      }
      const pct = pctOf.get(r.factors.familyId)
      if (pct == null || pct >= 100) {
        lines[sku] = { ...r, unitUsd: null, commissionPct: null, commissionUnitUsd: null, reason: `agente ${agent.name}: sem % de comissão para ${r.factors.family}` }
        continue
      }
      const unit = roundUpUsd(base / (1 - pct / 100))
      lines[sku] = {
        ...r,
        unitUsd: unit,
        commissionPct: pct,
        commissionUnitUsd: Math.round(unit * pct) / 100,
        reason: null,
        warning: commissionOutsideUsual(pct) ? `comissão ${pct}% fora da faixa usual (${COMMISSION_USUAL.min}–${COMMISSION_USUAL.max}%)` : null,
      }
    }
    const pricing: FrozenPricing = { ...fp, agent: agent ? { id: agent.id, name: agent.name } : null, lines, recommissionedAt: new Date().toISOString() }
    await db.update(schema.loadPlanVersions).set({ pricing }).where(eq(schema.loadPlanVersions.id, v.id))
    n++
  }
  return n
}
