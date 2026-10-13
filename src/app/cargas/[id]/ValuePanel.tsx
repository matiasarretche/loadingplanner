import Link from 'next/link'
import { dtSec } from '@/components/format'
import type { planValue } from '@/lib/loadPricing'

const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

/**
 * Valor do pedido — USO INTERNO (versão salva): preço por produto, total, produtos sem preço com o
 * motivo e a comissão do agente (incluída no preço; o PDF do cliente não a mostra).
 */
export function ValuePanel({ pv }: { pv: Awaited<ReturnType<typeof planValue>> }) {
  const { value, pricing, source } = pv
  const total = value.totals.USD
  const lines = value.lines
  const origin =
    source === 'live'
      ? 'calculado agora com a tabela vigente (atualiza enquanto a carga não for aprovada)'
      : source === 'frozen'
        ? `congelado na aprovação (${pricing ? dtSec(pricing.computedAt) : ''}) — não muda com a tabela`
        : 'aprovada antes do módulo de preços: preços antigos guardados na carga'
  return (
    <details className="panel no-print" style={{ marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>Valor do pedido</strong>{' '}
        <span className="muted">
          (interno · versão salva) · {total != null ? `USD ${usd.format(total)}` : 'sem preço'}
          {value.missing.length ? ` · ${value.missing.length} produto(s) sem preço` : ''}
          {value.commissionUsd ? ` · comissão do agente USD ${usd.format(value.commissionUsd)}` : ''}
        </span>
      </summary>
      <p className="muted" style={{ margin: '6px 0' }}>
        {origin}
        {pricing && (
          <>
            {' '}
            · destino {pricing.country ?? '—'} · {pricing.category ?? 'sem categoria'}
            {pricing.agent ? ` · via agente ${pricing.agent.name} (comissão incluída no preço; não aparece no PDF)` : ''}
          </>
        )}
        {' · '}
        <Link href="/precos-exportacao">Preços de exportação</Link>
      </p>
      <table className="data compact">
        <thead>
          <tr>
            <th>Produto</th>
            <th className="num">Unidades</th>
            <th className="num" title="USD/kg líquido aplicado (regra relativa: o da família de referência)">USD/kg</th>
            <th className="num">Preço unitário USD</th>
            <th className="num">Total USD</th>
            {pricing?.agent && <th className="num">Comissão</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const p = pricing?.lines[l.sku]
            return (
              <tr key={l.sku}>
                <td>{l.sku}</td>
                <td className="num">{nf.format(l.quantity)}</td>
                <td className="num" title={p?.factors ? `${p.factors.family}${p.factors.fixedUsdPerUnit != null ? ` + ${usd.format(p.factors.fixedUsdPerUnit)} USD/un.` : ''}${p.factors.refFamily ? ` (= ${p.factors.refFamily} + ${p.factors.markupPct}%)` : ''}${p.factors.priceAsSku ? ` · preço do ${p.factors.priceAsSku} (2 m, mesma capacidade)` : ''}${p.factors.priceBand ? ` · faixa ${p.factors.priceBand}` : ''}` : undefined}>
                  {p?.factors?.usdPerKg != null ? p.factors.usdPerKg.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}
                </td>
                <td className="num">{l.unitPrice != null ? usd.format(l.unitPrice) : <span style={{ color: 'var(--crit)' }}>{value.reasons[l.sku] ?? 'sem preço'}</span>}</td>
                <td className="num">{l.amount != null ? usd.format(l.amount) : '—'}</td>
                {pricing?.agent && (
                  <td className="num" title={p?.warning ?? undefined} style={{ color: p?.warning ? '#b35f00' : undefined }}>
                    {p?.commissionPct != null ? `${nf.format(p.commissionPct)}% · USD ${usd.format((p.commissionUnitUsd ?? 0) * l.quantity)}` : '—'}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </details>
  )
}
