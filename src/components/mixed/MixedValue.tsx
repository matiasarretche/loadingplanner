'use client'

import { configFromPayload, PricingPayload, quotePrice } from '@/domain/exportPricing'
import type { OrderLine } from '@/domain/mixedPallets'
import { countryCode } from '@/lib/countries'
import type { PdfValue } from '@/lib/pdf/orderPdf'

const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

export interface MixedValueLine {
  sku: string
  name: string
  units: number
  unitUsd: number | null
  amount: number | null
  reason: string | null
  commissionPct: number | null
  commissionUsd: number | null
  warning: string | null
}

/**
 * Valor do pedido do planejamento (paletes mistos / courier) pelo módulo Preços de exportação:
 * país de destino → categoria; família e marca do catálogo; peso líquido da embalagem; agente
 * (comissão incluída no preço, % do preço final). Quantidade = unidades pedidas (com os acompanhantes).
 */
export function mixedOrderValue(payload: PricingPayload, order: OrderLine[], destination: string, agentId: number | null, incoterm: string | null = null): { lines: MixedValueLine[]; totalUsd: number | null; commissionUsd: number; category: string | null; pdf: PdfValue } {
  const cfg = configFromPayload(payload)
  const cc = countryCode(destination) ?? null
  const prod = new Map(payload.products.map((p) => [p.sku.toUpperCase(), p]))
  const bySku = new Map<string, { name: string; units: number; netKg: number; familyId: number | null; brand: string | null }>()
  for (const o of order) {
    const k = o.pack.sku
    const units = o.boxes * Math.max(1, o.pack.unitsPerPackage)
    const cur = bySku.get(k)
    if (cur) cur.units += units
    else {
      const p = prod.get(k.toUpperCase())
      bySku.set(k, { name: o.pack.name, units, netKg: o.pack.netKg / Math.max(1, o.pack.unitsPerPackage), familyId: p?.familyId ?? null, brand: p?.brand ?? null })
    }
  }
  let total = 0
  let commission = 0
  let category: string | null = null
  const lines: MixedValueLine[] = [...bySku].map(([sku, x]) => {
    const base = { sku, name: x.name, units: x.units, commissionPct: null, commissionUsd: null, warning: null }
    if (x.familyId == null) return { ...base, unitUsd: null, amount: null, reason: 'produto não encontrado no catálogo' }
    const r = quotePrice(cfg, { sku, familyId: x.familyId, brand: x.brand, netKg: x.netKg }, cc, { agentId, incoterm })
    if (r.category) category = r.category.name
    if (!r.ok) return { ...base, unitUsd: null, amount: null, reason: r.reason }
    if (r.commission && r.commission.pct == null) return { ...base, unitUsd: null, amount: null, reason: r.commission.warning ?? 'sem % de comissão' }
    const amount = Math.round(r.unitUsd * x.units * 100) / 100
    total += amount
    const com = (r.commission?.commissionUsd ?? 0) * x.units
    commission += com
    return { ...base, unitUsd: r.unitUsd, amount, reason: null, commissionPct: r.commission?.pct ?? null, commissionUsd: r.commission ? Math.round(com * 100) / 100 : null, warning: r.commission?.warning ?? null }
  })
  const totalUsd = lines.some((l) => l.unitUsd != null) ? Math.round(total * 100) / 100 : null
  return {
    lines,
    totalUsd,
    commissionUsd: Math.round(commission * 100) / 100,
    category,
    // PDF do cliente: preço com a comissão já dentro; a comissão não aparece
    pdf: { lines: lines.map((l) => ({ sku: l.sku, name: l.name, units: l.units, unitUsd: l.unitUsd, amount: l.amount })), totalUsd, missing: lines.filter((l) => l.unitUsd == null).map((l) => l.sku), incoterm },
  }
}

/** Painel de valor (interno): preço por produto, total, sem preço com o motivo e comissão do agente. */
export function MixedValuePanel({ payload, value, destination, agentId, onAgent, incoterm, onIncoterm, stale }: { payload: PricingPayload; value: ReturnType<typeof mixedOrderValue>; destination: string; agentId: number | null; onAgent: (id: number | null) => void; incoterm: string; onIncoterm: (v: string) => void; stale?: boolean }) {
  const missing = value.lines.filter((l) => l.unitUsd == null).length
  return (
    <details className="panel" style={{ marginTop: 12 }} open>
      <summary style={{ cursor: 'pointer' }}>
        <strong>Valor do pedido</strong>{' '}
        <span className="muted">
          (interno) · {value.totalUsd != null ? `USD ${usd.format(value.totalUsd)}` : 'sem preço'}
          {missing ? ` · ${missing} produto(s) sem preço` : ''}
          {agentId != null && value.commissionUsd ? ` · comissão do agente USD ${usd.format(value.commissionUsd)}` : ''}
        </span>
      </summary>
      <div className="row" style={{ gap: 10, margin: '6px 0', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted">
          Destino {destination.trim() || '—'} · {value.category ?? 'sem categoria comercial'}
        </span>
        <label title="CIF soma o recargo por kg líquido ao preço">
          Incoterm{' '}
          <select value={incoterm} onChange={(e) => onIncoterm(e.target.value)}>
            <option value="FOB">FOB / demais</option>
            <option value="CIF">CIF</option>
          </select>
        </label>
        <label title="Comissão incluída no preço (% do preço final); não aparece no PDF">
          Venda via agente{' '}
          <select value={agentId ?? ''} onChange={(e) => onAgent(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Não</option>
            {payload.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <small className="muted">O PDF leva o preço unitário e o total (com a comissão já incluída, sem mostrá-la). Cada PDF com preço fica registrado em Preços exportação → Cotações emitidas.</small>
      </div>
      {stale && <div className="alert warn">O pedido mudou depois de otimizar os paletes: clique em otimizar de novo. O PDF usa o pedido otimizado (o mesmo dos paletes).</div>}
      <table className="data compact">
        <thead>
          <tr>
            <th>Produto</th>
            <th className="num">Unidades</th>
            <th className="num">Preço unitário USD</th>
            <th className="num">Total USD</th>
            {agentId != null && <th className="num">Comissão</th>}
          </tr>
        </thead>
        <tbody>
          {value.lines.map((l) => (
            <tr key={l.sku}>
              <td title={l.name}>{l.sku}</td>
              <td className="num">{nf.format(l.units)}</td>
              <td className="num">{l.unitUsd != null ? usd.format(l.unitUsd) : <span style={{ color: 'var(--crit)' }}>{l.reason}</span>}</td>
              <td className="num">{l.amount != null ? usd.format(l.amount) : '—'}</td>
              {agentId != null && (
                <td className="num" title={l.warning ?? undefined} style={{ color: l.warning ? '#b35f00' : undefined }}>
                  {l.commissionPct != null ? `${nf.format(l.commissionPct)}% · USD ${usd.format(l.commissionUsd ?? 0)}` : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
