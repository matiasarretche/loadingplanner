'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BALANCE_WHEN_OPTIONS, BalanceWhen, balanceWhenLabel, parseMoney, PaymentTerms, paymentTermsErrors, paymentTermsText } from '@/domain/paymentTerms'
import { proformaTotals } from '@/domain/pricing'
import { setPlanAgentAction, updateCommercialAction } from '../actions'

const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))
const parse = (v: string) => parseMoney(v)

/**
 * Proforma e transporte da carga: transportadora (por código ou nome), frete e seguro em USD (somados
 * uma vez ao subtotal da mercadoria) e condições de pagamento (saem escritas no idioma do PDF).
 */
export function ProformaPanel(p: {
  planId: number
  exportArea: boolean
  editable: boolean
  goodsUsd: number | null
  incoterm: string | null
  companies: { id: number; code: string; name: string; active: boolean }[]
  /** agentes (comissão incluída no preço desta carga) */
  agents: { id: number; name: string; active: boolean }[]
  value: { agentId: number | null; transportCompanyId: number | null; freightUsd: number | null; insuranceUsd: number | null; paymentTerms: PaymentTerms | null }
}) {
  const router = useRouter()
  const cur = p.companies.find((c) => c.id === p.value.transportCompanyId)
  const label = (c: { code: string; name: string }) => `${c.code} — ${c.name}`
  const [company, setCompany] = useState(cur ? label(cur) : '')
  const [agent, setAgent] = useState(p.value.agentId != null ? String(p.value.agentId) : '')
  const [freight, setFreight] = useState(num(p.value.freightUsd))
  const [insurance, setInsurance] = useState(num(p.value.insuranceUsd))
  const t0 = p.value.paymentTerms
  const [hasTerms, setHasTerms] = useState(Boolean(t0))
  const [advance, setAdvance] = useState(t0 ? String(t0.advancePct) : '100')
  const [when, setWhen] = useState<BalanceWhen>(t0?.balanceWhen ?? 'BEFORE_SHIPMENT')
  const [days, setDays] = useState(t0?.days != null ? String(t0.days) : '')
  const [note, setNote] = useState(t0?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const terms: PaymentTerms | null = hasTerms ? { advancePct: Number(advance.replace(',', '.')), balanceWhen: Number(advance.replace(',', '.')) >= 100 ? null : when, days: days.trim() ? Number(days) : null, note: note.trim() || null } : null
  const termErrors = terms ? paymentTermsErrors(terms) : []
  const f = parse(freight)
  const i = parse(insurance)
  const tot = proformaTotals(p.goodsUsd, Number.isNaN(f) ? null : f, Number.isNaN(i) ? null : i)
  const resolved = company.trim() ? p.companies.find((c) => label(c).toLowerCase() === company.trim().toLowerCase() || c.code.toLowerCase() === company.trim().toLowerCase() || c.name.toLowerCase() === company.trim().toLowerCase()) : null

  /** agente: grava ao escolher (não depende do botão Salvar) e recalcula o preço */
  async function chooseAgent(v: string) {
    const prev = agent
    setAgent(v)
    setBusy(true)
    setMsg(null)
    const r = await setPlanAgentAction(p.planId, v ? Number(v) : null).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) {
      setAgent(prev)
      return setMsg({ type: 'error', text: r.error })
    }
    const name = p.agents.find((a) => String(a.id) === v)?.name
    setMsg({ type: 'ok', text: v ? `Agente ${name} gravado: o preço da carga já inclui a comissão dele${r.recommissioned ? ' (versão aprovada re-congelada)' : ''}.` : 'Carga sem agente: preço sem comissão.' })
    router.refresh()
  }

  async function save() {
    setBusy(true)
    setMsg(null)
    const r = await updateCommercialAction(p.planId, { transportCompany: company, freightUsd: freight, insuranceUsd: insurance, paymentTerms: terms }).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) return setMsg({ type: 'error', text: r.error })
    setMsg({ type: 'ok', text: 'Salvo. O próximo PDF do pedido já sai com estes dados.' })
    router.refresh()
  }

  return (
    <details className="panel no-print" style={{ marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>{p.exportArea ? 'Proforma e transporte' : 'Transporte'}</strong>{' '}
        <span className="muted">
          · transportadora {cur ? label(cur) : '—'}
          {p.exportArea && (
            <>
              {p.value.freightUsd ? ` · frete USD ${usd.format(p.value.freightUsd)}` : ''}
              {p.value.insuranceUsd ? ` · seguro USD ${usd.format(p.value.insuranceUsd)}` : ''}
              {t0 ? ` · pagamento: ${paymentTermsText(t0, 'pt')}` : ' · condições de pagamento não definidas'}
            </>
          )}
        </span>
      </summary>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <label className="field">
          Transportadora (código ou nome)
          <input list={`tc-${p.planId}`} value={company} onChange={(e) => setCompany(e.target.value)} disabled={!p.editable || busy} placeholder="digite o código ou o nome" />
          <datalist id={`tc-${p.planId}`}>
            {p.companies
              .filter((c) => c.active || c.id === p.value.transportCompanyId)
              .map((c) => (
                <option key={c.id} value={label(c)} />
              ))}
          </datalist>
          {company.trim() && !resolved && <small style={{ color: 'var(--crit)' }}>não encontrada — cadastre em Cadastros → Transportadoras</small>}
          {resolved && !resolved.active && <small style={{ color: '#b35f00' }}>transportadora inativa</small>}
        </label>
        {p.exportArea && (
          <>
            <label className="field" title="Agente desta carga: a comissão dele (por família de produto) entra no preço. Vem do cadastro do cliente; pode ser trocado por carga.">
              Agente (comissão no preço)
              <select value={agent} onChange={(e) => void chooseAgent(e.target.value)} disabled={!p.editable || busy}>
                <option value="">— sem agente —</option>
                {p.agents
                  .filter((a) => a.active || String(a.id) === agent)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              <small className="muted">Grava na hora: o preço passa a incluir a comissão do agente (também numa versão já aprovada).</small>
            </label>
            <label className="field">
              Frete (USD)
              <input inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} disabled={!p.editable || busy} placeholder="0,00" style={{ borderColor: Number.isNaN(f) ? 'var(--crit)' : undefined }} />
            </label>
            <label className="field">
              Seguro (USD)
              <input inputMode="decimal" value={insurance} onChange={(e) => setInsurance(e.target.value)} disabled={!p.editable || busy} placeholder="0,00" style={{ borderColor: Number.isNaN(i) ? 'var(--crit)' : undefined }} />
            </label>
          </>
        )}
      </div>
      {p.exportArea && (
        <>
          <p className="muted" style={{ margin: '4px 0' }}>
            Incoterm {p.incoterm ?? '—'} · mercadoria {p.goodsUsd != null ? `USD ${usd.format(p.goodsUsd)}` : 'sem preço'}
            {tot.freightUsd ? ` + frete USD ${usd.format(tot.freightUsd)}` : ''}
            {tot.insuranceUsd ? ` + seguro USD ${usd.format(tot.insuranceUsd)}` : ''}
            {(tot.freightUsd || tot.insuranceUsd) && tot.totalUsd != null ? ` = total USD ${usd.format(tot.totalUsd)}` : ''}
            <span> · o PDF mostra o subtotal da mercadoria, o frete, o seguro e o total geral (cada valor somado uma única vez).</span>
          </p>
          <fieldset style={{ marginTop: 6 }}>
            <legend>
              <label className="check">
                <input type="checkbox" checked={hasTerms} onChange={(e) => setHasTerms(e.target.checked)} disabled={!p.editable || busy} /> Condições de pagamento
              </label>
            </legend>
            {hasTerms && (
              <>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="field" style={{ width: 120 }}>
                    % antecipado
                    <input inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value)} disabled={!p.editable || busy} />
                  </label>
                  {Number(advance.replace(',', '.')) < 100 && (
                    <>
                      <label className="field">
                        Saldo
                        <select value={when} onChange={(e) => setWhen(e.target.value as BalanceWhen)} disabled={!p.editable || busy}>
                          {BALANCE_WHEN_OPTIONS.map((w) => (
                            <option key={w} value={w}>
                              {balanceWhenLabel(w)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {when.startsWith('DAYS_') && (
                        <label className="field" style={{ width: 90 }}>
                          Dias
                          <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={!p.editable || busy} />
                        </label>
                      )}
                    </>
                  )}
                  <label className="field" style={{ flex: 1, minWidth: 220 }}>
                    Nota livre (opcional; sai como digitada)
                    <input value={note} onChange={(e) => setNote(e.target.value)} disabled={!p.editable || busy} maxLength={300} />
                  </label>
                </div>
                {termErrors.length ? (
                  <small style={{ color: 'var(--crit)' }}>{termErrors.join(' ')}</small>
                ) : (
                  <div className="muted" style={{ fontSize: 12 }}>
                    PDF — pt: {paymentTermsText(terms, 'pt')} · es: {paymentTermsText(terms, 'es')} · en: {paymentTermsText(terms, 'en')}
                  </div>
                )}
              </>
            )}
          </fieldset>
        </>
      )}
      {msg && <div className={`alert ${msg.type}`} style={{ marginTop: 6 }}>{msg.text}</div>}
      {p.editable && (
        <button className="primary" style={{ marginTop: 8 }} disabled={busy || termErrors.length > 0 || Number.isNaN(f) || Number.isNaN(i) || (company.trim() !== '' && !resolved)} onClick={() => void save()}>
          {busy ? 'Salvando…' : 'Salvar proforma e transporte'}
        </button>
      )}
    </details>
  )
}
