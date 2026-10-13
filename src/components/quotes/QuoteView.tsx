import { dt } from '@/components/format'
import { quoteSummary, QuoteSnapshotLine } from '@/domain/pricing'
import { countryNamePt } from '@/lib/countries'
import { orderRefLabel } from '@/lib/orderRef'

/** Cotação emitida como é exibida (dados serializáveis vindos de price_quote). */
export interface IssuedQuote {
  id: number
  /** 'load' (PDF de uma carga) | 'mixed' (paletes mistos) | 'courier' */
  origin: string
  loadPlanId: number | null
  /** a carga ainda existe? (cotações continuam registradas mesmo se a carga for excluída) */
  loadExists: boolean
  version: number | null
  /** paletes mistos/courier: referência digitada */
  reference: string | null
  planName: string
  customerName: string | null
  orderRef: string | null
  status: string
  source: string
  country: string | null
  category: string | null
  agentName: string | null
  /** subtotal da mercadoria */
  totalUsd: number | null
  incoterm: string | null
  freightUsd: number | null
  insuranceUsd: number | null
  /** mercadoria + frete + seguro */
  grandTotalUsd: number | null
  paymentTerms: string | null
  transportCompany: string | null
  commissionUsd: number | null
  lines: QuoteSnapshotLine[]
  firstIssuedAt: string
  lastIssuedAt: string
  issueCount: number
  /** quem emitiu a primeira vez e a última */
  firstIssuedBy: string | null
  issuedBy: string | null
}

const ORIGIN: Record<string, string> = { mixed: 'Paletes mistos', courier: 'Courier' }
const STATUS: Record<string, string> = { APPROVED: 'aprovada', SUPERSEDED: 'substituída', IN_REVIEW: 'em revisão', DRAFT: 'rascunho', PLANNER: 'sem carga' }

const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usd4 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

const METHOD: Record<string, string> = { PER_KG: 'USD/kg', PER_KG_PLUS_FIXED: 'USD/kg + fixo', INCLUDED: 'incluído', RELATIVE: '% sobre outra família' }
const SOURCE: Record<string, string> = { live: 'tabela vigente na data', frozen: 'congelado na aprovação', legacy: 'preço antigo (antes do módulo)' }

/** Resumo de uma linha: categoria · comissão · USD/kg principal. */
export function quoteHeadline(q: IssuedQuote) {
  const s = quoteSummary(q.lines)
  const commission = s.commissionPcts.length ? `com comissão ${s.commissionPcts.map((p) => `${nf.format(p)}%`).join(' / ')}${q.agentName ? ` (${q.agentName})` : ''}` : 'sem comissão'
  const principal = s.principal
    ? `${s.principal.family}${s.principal.bands.length ? ` ${s.principal.bands.join(' / ')}` : ''}: ${s.principal.refFamily ? `= ${s.principal.refFamily} ` : ''}${s.principal.usdPerKg != null ? `${usd4.format(s.principal.usdPerKg)} USD/kg` : METHOD[s.principal.method] ?? s.principal.method}${s.principal.fixedUsdPerUnit != null ? ` + ${usd.format(s.principal.fixedUsdPerUnit)} USD/un.` : ''}${s.principal.refFamily ? ` + ${nf.format(s.principal.markupPct ?? 0)}%` : ''} (${nf.format(s.principal.sharePct)}% do valor${s.principal.groups > 1 ? ` com as outras faixas de ${s.principal.family}` : ''})`
    : q.source === 'legacy'
      ? 'fatores não registrados (preço antigo)'
      : '—'
  return { summary: s, commission, principal }
}

/** Detalhe por produto: como cada preço foi calculado na data da emissão. */
export function QuoteDetails({ q }: { q: IssuedQuote }) {
  const { summary } = quoteHeadline(q)
  return (
    <div style={{ marginTop: 6 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        {q.issueCount > 1
          ? `Emitida ${q.issueCount}× · primeira em ${dt(q.firstIssuedAt)}${q.firstIssuedBy ? ` por ${q.firstIssuedBy}` : ''} · última em ${dt(q.lastIssuedAt)}${q.issuedBy ? ` por ${q.issuedBy}` : ''}`
          : `Emitida em ${dt(q.firstIssuedAt)}${q.firstIssuedBy ? ` por ${q.firstIssuedBy}` : ''}`}
        {q.version != null ? ` · V${q.version}` : ''} ({ORIGIN[q.origin] ?? STATUS[q.status] ?? q.status}) · origem do preço: {SOURCE[q.source] ?? q.source}
        {summary.brandAdjusts.length ? ` · ajuste por marca: ${summary.brandAdjusts.map((b) => `${b.brand} ${nf.format(b.pct)}%`).join(', ')}` : ''}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Incoterm {q.incoterm ?? '—'}
        {q.lines.some((l) => l.factors?.cifUsdPerKg) ? ` · recargo CIF ${[...new Set(q.lines.map((l) => l.factors?.cifUsdPerKg).filter((x): x is number => x != null))].map((x) => usd4.format(x)).join(' / ')} USD/kg` : ''}
        {' · '}mercadoria USD {q.totalUsd != null ? usd.format(q.totalUsd) : '—'}
        {q.freightUsd ? ` + frete USD ${usd.format(q.freightUsd)}` : ''}
        {q.insuranceUsd ? ` + seguro USD ${usd.format(q.insuranceUsd)}` : ''}
        {q.freightUsd || q.insuranceUsd ? ` = total USD ${q.grandTotalUsd != null ? usd.format(q.grandTotalUsd) : '—'}` : ''}
        {q.paymentTerms ? ` · pagamento: ${q.paymentTerms}` : ''}
        {q.transportCompany ? ` · transportadora: ${q.transportCompany}` : ''}
      </div>
      {summary.byFamily.length > 1 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          USD/kg por família:{' '}
          {summary.byFamily
            .filter((f) => f.method !== 'INCLUDED')
            .map((f) => `${f.family}${f.bands.length ? ` ${f.bands.join(' / ')}` : ''} ${f.usdPerKg != null ? usd4.format(f.usdPerKg) : '—'}${f.fixedUsdPerUnit != null ? ` + ${usd.format(f.fixedUsdPerUnit)}/un.` : ''}${f.refFamily ? ` (= ${f.refFamily} + ${nf.format(f.markupPct ?? 0)}%)` : ''} · ${nf.format(f.sharePct)}%`)
            .join(' | ')}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="data compact">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="num">Unid.</th>
              <th>Família / regra</th>
              <th className="num">USD/kg</th>
              <th className="num">Fixo USD/un.</th>
              <th className="num">Líq. kg/un.</th>
              <th className="num">Marca</th>
              <th className="num">CIF USD/kg</th>
              <th className="num">Base USD</th>
              <th className="num">Comissão</th>
              <th className="num">Preço USD</th>
              <th className="num">Total USD</th>
            </tr>
          </thead>
          <tbody>
            {q.lines.map((l) => {
              const f = l.factors
              return (
                <tr key={l.sku}>
                  <td title={l.name}>{l.sku}</td>
                  <td className="num">{nf.format(l.units)}</td>
                  <td>
                    {f ? (
                      <>
                        {f.family} <small className="muted">· {METHOD[f.method] ?? f.method}{f.refFamily ? ` (${f.refFamily} + ${nf.format(f.markupPct ?? 0)}%)` : ''}</small>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {f?.usdPerKg != null ? usd4.format(f.usdPerKg) : '—'}
                    {f?.priceBand ? (
                      <small className="muted" style={{ display: 'block' }}>
                        {f.priceBand}
                      </small>
                    ) : null}
                  </td>
                  <td className="num">{f?.fixedUsdPerUnit != null ? usd.format(f.fixedUsdPerUnit) : '—'}</td>
                  <td className="num" title={f?.priceAsSku ? `Peso do ${f.priceAsSku} (Hidrosilo 2 m, mesma capacidade): o 3 m tem o mesmo preço do 2 m` : undefined}>
                    {f ? nf.format(f.netKgUnit) : '—'}
                    {f?.priceAsSku ? (
                      <small className="muted" style={{ display: 'block' }}>
                        = {f.priceAsSku} (2 m)
                      </small>
                    ) : null}
                  </td>
                  <td className="num">{f?.brandAdjustPct ? `${f.brand} ${nf.format(f.brandAdjustPct)}%` : '—'}</td>
                  <td className="num">{f?.cifUsdPerKg ? usd4.format(f.cifUsdPerKg) : '—'}</td>
                  <td className="num">{f ? usd.format(f.baseUnitUsd) : '—'}</td>
                  <td className="num">{l.commissionPct ? `${nf.format(l.commissionPct)}%` : '—'}</td>
                  <td className="num">{l.unitUsd != null ? <strong>{usd.format(l.unitUsd)}</strong> : <span style={{ color: 'var(--crit)' }}>{l.reason ?? 'sem preço'}</span>}</td>
                  <td className="num">{l.amount != null ? usd.format(l.amount) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {q.commissionUsd ? <small className="muted">Comissão total do agente (interno): USD {usd.format(q.commissionUsd)} — não aparece no PDF do cliente.</small> : null}
    </div>
  )
}

/** Uma cotação emitida em uma linha (data · versão · total · categoria · comissão · USD/kg principal), expansível. */
export function QuoteRow({ q, showPlan }: { q: IssuedQuote; showPlan?: boolean }) {
  const h = quoteHeadline(q)
  return (
    <details style={{ borderBottom: '1px solid var(--line, #e3e8ec)', padding: '6px 0' }}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>{dt(q.firstIssuedAt)}</strong>
        {q.issueCount > 1 ? <small className="muted"> (+{q.issueCount - 1}, última {dt(q.lastIssuedAt)})</small> : null}
        {showPlan && (
          <>
            {' · '}
            {q.loadExists && q.loadPlanId != null ? <a href={`/cargas/${q.loadPlanId}?v=${q.version ?? ''}`}>{q.planName}</a> : <span>{q.planName}</span>}
            {q.origin !== 'load' ? <small className="muted"> ({ORIGIN[q.origin] ?? q.origin})</small> : !q.loadExists ? <small className="muted"> (carga excluída)</small> : null}
            {q.customerName ? ` · ${q.customerName}` : ''}
          </>
        )}
        {q.orderRef ? ` · ${orderRefLabel(q.orderRef, 'EXPORT')}` : ''}
        {q.version != null ? ` · V${q.version}` : ''} · <strong>{(q.grandTotalUsd ?? q.totalUsd) != null ? `USD ${usd.format((q.grandTotalUsd ?? q.totalUsd)!)}` : 'sem preço'}</strong>{q.incoterm ? ` ${q.incoterm}` : ''} · {q.category ?? 'sem categoria'}
        {q.country ? ` (${countryNamePt(q.country)})` : ''} · {h.commission} · <span title="USD/kg da família com maior valor na cotação">principal {h.principal}</span>
      </summary>
      <QuoteDetails q={q} />
    </details>
  )
}
