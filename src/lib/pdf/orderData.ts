import { loadGeometries, validateLoad } from '@/domain/load'
import { noneMetrics } from '@/domain/noEquipment'
import { serviceOf, TYPE_INFO } from '@/domain/shipmentType'
import { palletBoxCounts } from '@/domain/partial'
import { palletSummary } from '@/domain/pallet'
import { palletDisplayName } from '@/domain/mixedLoad'
import { palletTareBySku } from '@/domain/weights'
import { kitBoxLines, kitFamilyOf } from '@/domain/kitBoxes'
import type { PackSnapshot } from '@/domain/types'
import { OrderValue, orderValue } from '@/domain/pricing'
import { DEFAULT_QUADRANT_RULES, evaluateQuadrants, quadrantShares } from '@/domain/quadrants'
import type { loadPlanVersion } from '@/lib/planData'
import type { FamilyTech } from '@/domain/technology'
import type { OrderPdfData } from './orderPdf'

type PlanData = NonNullable<Awaited<ReturnType<typeof loadPlanVersion>>>

/** Conteúdo do PDF a partir da versão SALVA (o documento sempre bate com o que foi registrado). */
/** `rank` = ordem única de produtos (productRank): a tabela de produtos sai na mesma ordem do catálogo. */
/** `value` = valor do pedido já resolvido (planValue: tabela vigente, congelado na aprovação ou preços antigos). */
/** `techBySku` = tecnologia da família de cada SKU (maiúsculas) no Catálogo (productTechBySku): selo PACIFIL NXT. */
export function orderPdfData(data: PlanData, rank?: Map<string, number>, given?: OrderValue, techBySku?: Map<string, FamilyTech>): OrderPdfData {
  const doc = data.v.document
  const { summary: s } = validateLoad(doc)
  // comissão do agente já está DENTRO do preço unitário; o PDF do cliente não a mostra
  const value = given ?? orderValue(doc)
  const priceBySku = new Map(value.lines.map((l) => [l.sku, l]))
  const geoms = loadGeometries(doc)
  const tareBySku = palletTareBySku(doc)

  // paletes agrupados pela montagem (parciais aparecem à parte)
  const groups = new Map<string, OrderPdfData['pallets'][number]>()
  for (const g of geoms) {
    if (g.unit.kind !== 'PALLET') continue
    const p = doc.pallets[g.unit.palletKey]
    const c = palletBoxCounts(p)
    const ps = palletSummary(p)
    // cargas antigas: "Misto N · SKU" de um produto só aparece (e agrupa) só pelo SKU
    const name = palletDisplayName(p)
    const key = `${name}|${c.boxes}|${Math.round(ps.grossKg)}`
    const cur = groups.get(key) ?? { name, count: 0, boxes: c.boxes, fullBoxes: c.partial ? c.fullBoxes : null, grossKgEach: ps.grossKg }
    cur.count++
    groups.set(key, cur)
  }

  const noNet = s.bySku.filter((l) => l.netKg <= 0).map((l) => l.sku)
  // caixas de kits por SKU (uma entrada por caixa física), para mostrar o tipo na linha do KIT-HF
  const kitPacks = new Map<string, PackSnapshot[]>()
  for (const g of geoms) {
    const u = g.unit
    const pd = u.kind === 'PALLET' ? doc.pallets[u.palletKey] : undefined
    const list = u.kind === 'PALLET' ? (pd?.items ?? []).map((it) => pd!.packs[it.packId]) : [doc.packs[u.packId]]
    for (const k of list) if (k && kitFamilyOf(k.sku)) kitPacks.set(k.sku, [...(kitPacks.get(k.sku) ?? []), k])
  }
  const kitBoxesOf = (sku: string) => (kitPacks.get(sku)?.some((k) => k.kitBox) ? { kitBoxes: kitBoxLines(kitPacks.get(sku)!) } : {})

  return {
    company: 'Pacifil Brasil',
    generatedAt: new Date(),
    plan: { name: data.plan.name, version: data.v.version, status: data.v.status },
    customer: { name: data.customer?.name ?? '—', country: data.customer?.country, city: data.customer?.city, taxId: data.customer?.taxId },
    order: {
      ref: data.shipment?.orderRef,
      incoterm: data.shipment?.incoterm ?? '—',
      destination: data.shipment?.destinationCountry ?? '—',
      // envio sem equipamento: origem/destino rotulados pelo tipo (portos, aeroportos ou endereços)
      mode: data.shipment?.mode ?? TYPE_INFO[serviceOf(data.shipment)].placeMode,
      service: serviceOf(data.shipment),
      originPlace: data.shipment?.originPlace ?? null,
      destinationPlace: data.shipment?.destinationPlace ?? null,
      customerAddress: data.shipment?.customerAddress ?? data.customer?.address ?? null,
    },
    // sem equipamento: bloco do ENVIO (paletes/volumes, CBM, pesos, taxável) no lugar do equipamento
    shipping: doc.space.kind === 'NONE' ? (() => {
      const m = noneMetrics(doc)
      return { service: doc.space.service ?? 'PALLETS_ONLY', maxHeightMm: doc.space.service === 'COURIER' ? null : doc.space.inner.h, pallets: m.pallets, boxes: m.boxes, grossKg: m.grossKg, netKg: m.netKg, cbm: m.cbm, chargeableKg: m.chargeableKg, courier: m.courier }
    })() : null,
    equipment: doc.space.kind === 'NONE' ? null : {
      code: doc.space.code,
      name: doc.space.name,
      innerMm: `${doc.space.inner.l} × ${doc.space.inner.w} × ${doc.space.inner.h}`,
      lengthInformed: doc.space.baseInnerL != null,
      doorMm: `${doc.space.door.w} × ${doc.space.door.h}`,
      tareKg: doc.space.tareKg,
      payloadLimitKg: s.limits.payloadKg.value,
      grossLimitKg: s.limits.grossKg.value,
      estimated: doc.space.verification !== 'VERIFIED',
    },
    products: [...s.bySku].sort((a, b) => (rank?.get(a.sku.toUpperCase()) ?? Number.MAX_SAFE_INTEGER) - (rank?.get(b.sku.toUpperCase()) ?? Number.MAX_SAFE_INTEGER)).map((l) => {
      const v = priceBySku.get(l.sku)
      return { sku: l.sku, name: l.name, boxes: l.packages, units: l.units, netKg: l.netKg, packedKg: l.grossKg, grossKg: l.grossKg + (tareBySku.get(l.sku) ?? 0), unitPrice: v?.unitPrice ?? null, currency: v?.currency ?? null, per: v?.per ?? null, amount: v?.amount ?? null, ...kitBoxesOf(l.sku), tech: techBySku?.get(l.sku.toUpperCase()) ?? null }
    }),
    pallets: [...groups.values()],
    totals: {
      pallets: s.pallets,
      looseBoxes: s.looseUnits,
      boxes: s.packages,
      units: s.units,
      netKg: s.netKg,
      goodsGrossKg: s.bySku.reduce((t, l) => t + l.grossKg, 0),
      palletTareKg: s.palletTareKg,
      payloadKg: s.payloadKg,
      payloadPct: s.payloadPct,
      equipmentTareKg: s.equipmentTareKg,
      grossTotalKg: s.grossKg,
      cbm: s.cbmUnits,
      volumePct: s.volumeUtilPct,
      floorPct: s.floorUtilPct,
      usedLengthMm: s.usedLengthMm,
    },
    value: { totals: value.totals, missing: value.missing },
    proforma: { freightUsd: data.plan.freightUsd ?? null, insuranceUsd: data.plan.insuranceUsd ?? null, paymentTerms: data.plan.paymentTerms ?? null },
    weight: doc.space.kind === 'NONE' ? null : (() => {
      const e = evaluateQuadrants(quadrantShares(doc))
      const q = e.shares
      const R = DEFAULT_QUADRANT_RULES
      return q.totalKg > 0 ? { NE: q.pct.NE, NO: q.pct.NO, SE: q.pct.SE, SO: q.pct.SO, north: q.northPct, south: q.southPct, ok: e.ok, zone: e.zone, rearMin: R.rearMinPct, rearIdealMin: R.rearIdealMinPct, rearMax: R.rearMaxPct } : null
    })(),
    flags: { equipmentReference: doc.space.verification !== 'VERIFIED', noNetSkus: noNet, notApproved: data.v.status !== 'APPROVED' },
  }
}
