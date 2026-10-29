'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { parseMoney, PaymentTerms, paymentTermsErrors, paymentTermsText } from '@/domain/paymentTerms'
import { proformaTotals } from '@/domain/pricing'
import { CFOP_PLACEHOLDER, cfopAreaWarning, cfopError, normalizeCfop } from '@/domain/cfop'
import { specialTransportCompany, specialTransportCompanyIds, transportCompanyLabel } from '@/domain/transportCompany'
import { TransportCompanyPicker, type PickerTransportCompany } from '@/components/TransportCompanyPicker'
import { PaymentTermsFields } from '@/components/PaymentTermsFields'
import { setPlanAgentAction, updateCommercialAction } from '../actions'
import { cfopEdit, termsKey } from './confirmCommercial'

const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))
const parse = (v: string) => parseMoney(v)

/**
 * Proforma, transporte e fiscal da carga: transportadora (busca entre as do ERP, vínculo pelo id), frete e
 * seguro em USD (somados uma vez ao subtotal da mercadoria), condição de pagamento (só Exportação; sai
 * escrita no idioma do PDF) e o CFOP do pedido (digitado à mão; uso interno/fiscal, não sai nos PDFs do
 * cliente). Com mais de uma unidade no pedido: a condição de pagamento (Exportação) vale SEMPRE para todas
 * as unidades; a transportadora é POR CARGA e a caixa "Aplicar a transportadora a todas as unidades" a leva às
 * outras — marcada por padrão só quando elas já têm a mesma (senão desmarcada, com aviso). Frete e seguro
 * continuam por unidade. O CFOP é do pedido e só é enviado se foi alterado aqui.
 */
export function ProformaPanel(p: {
  planId: number
  area: 'EXPORT' | 'DOMESTIC'
  editable: boolean
  goodsUsd: number | null
  incoterm: string | null
  /** transportadoras ativas + a vinculada a esta carga (mesmo inativa) */
  companies: PickerTransportCompany[]
  /** agentes (comissão incluída no preço desta carga) */
  agents: { id: number; name: string; active: boolean }[]
  /** quantidade de unidades (cargas) do pedido */
  orderUnits: number
  /** o pedido já foi confirmado (Exportações em curso) */
  orderConfirmed: boolean
  /** alguma outra unidade do pedido tem transportadora diferente desta */
  carrierDiffers?: boolean
  /** alguma outra unidade do pedido tem condição de pagamento diferente desta */
  termsDiffer?: boolean
  value: { agentId: number | null; transportCompanyId: number | null; freightUsd: number | null; insuranceUsd: number | null; paymentTerms: PaymentTerms | null; cfop: string | null }
}) {
  const router = useRouter()
  const exportArea = p.area === 'EXPORT'
  const byId = useMemo(() => new Map(p.companies.map((c) => [c.id, c])), [p.companies])
  const cur = p.value.transportCompanyId != null ? byId.get(p.value.transportCompanyId) ?? null : null
  // "Especiais" no topo do seletor: retirada pelo cliente, a definir, transporte próprio, Correios
  const featured = useMemo(() => {
    const ids = specialTransportCompanyIds(p.companies.filter((c) => c.active))
    return ids.length ? [{ label: 'Especiais', ids }] : undefined
  }, [p.companies])
  const [companyId, setCompanyId] = useState<number | null>(p.value.transportCompanyId)
  const [agent, setAgent] = useState(p.value.agentId != null ? String(p.value.agentId) : '')
  const [freight, setFreight] = useState(num(p.value.freightUsd))
  const [insurance, setInsurance] = useState(num(p.value.insuranceUsd))
  const [terms, setTerms] = useState<PaymentTerms | null>(p.value.paymentTerms)
  const [cfop, setCfop] = useState(p.value.cfop ?? '')
  // aplicar a transportadora às outras unidades: marcada só se não substitui nada (as outras já têm a mesma)
  const [applyAll, setApplyAll] = useState(!p.carrierDiffers)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const t0 = p.value.paymentTerms
  const termErrors = exportArea && terms ? paymentTermsErrors(terms) : []
  const f = parse(freight)
  const i = parse(insurance)
  const tot = proformaTotals(p.goodsUsd, Number.isNaN(f) ? null : f, Number.isNaN(i) ? null : i)
  const chosen = companyId != null ? byId.get(companyId) ?? null : null
  const cfopNorm = normalizeCfop(cfop)
  const cfopErr = cfopError(cfopNorm)
  const cfopWarn = cfopErr ? null : cfopAreaWarning(cfopNorm, p.area)
  const multi = p.orderUnits > 1
  const dis = !p.editable || busy

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
    const toAll = multi && applyAll
    const r = await updateCommercialAction(p.planId, {
      transportCompanyId: companyId,
      freightUsd: freight,
      insuranceUsd: insurance,
      // condição: só se editada aqui (senão o servidor mantém a gravada, que vale para todas as unidades); o
      // Mercado Interno não a edita
      ...(exportArea && termsKey(terms) !== termsKey(p.value.paymentTerms) ? { paymentTerms: terms } : {}),
      // CFOP (é do pedido): só se editado aqui, com o valor que o painel carregou — um painel desatualizado
      // não reverte o que outra pessoa gravou por outra unidade
      ...(cfopEdit(cfop, p.value.cfop) ?? {}),
      applyCarrierToOrder: toAll,
    }).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) return setMsg({ type: 'error', text: r.error })
    if (cfopNorm) setCfop(cfopNorm)
    const units = `nas ${p.orderUnits} unidades do pedido`
    const all = !multi
      ? ''
      : exportArea
        ? toAll
          ? `Transportadora e condição de pagamento gravadas ${units}. `
          : `Condição de pagamento gravada ${units}; transportadora só nesta. `
        : toAll
          ? `Transportadora gravada ${units}. `
          : ''
    setMsg({ type: 'ok', text: `Salvo. ${all}O próximo PDF do pedido já sai com estes dados.` })
    router.refresh()
  }

  return (
    <details className="panel no-print" style={{ marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>{exportArea ? 'Proforma, transporte e fiscal' : 'Transporte e fiscal'}</strong>{' '}
        <span className="muted">
          · transportadora {cur ? transportCompanyLabel(cur) : '—'}
          {exportArea && (
            <>
              {p.value.freightUsd ? ` · frete USD ${usd.format(p.value.freightUsd)}` : ''}
              {p.value.insuranceUsd ? ` · seguro USD ${usd.format(p.value.insuranceUsd)}` : ''}
              {t0 ? ` · pagamento: ${paymentTermsText(t0, 'pt')}` : ' · condição de pagamento não definida'}
            </>
          )}
          {` · CFOP ${p.value.cfop ?? 'não informado'}`}
        </span>
      </summary>
      {p.orderConfirmed && p.editable && (
        <div className="alert warn" style={{ margin: '8px 0 0' }}>
          Pedido já confirmado (Exportações em curso): alterar aqui muda os próximos PDFs; as cotações já emitidas ficam como foram enviadas.
        </div>
      )}
      <div className="form-grid" style={{ marginTop: 8 }}>
        <label className="field">
          Transportadora
          <TransportCompanyPicker companies={p.companies} value={companyId} onChange={setCompanyId} featured={featured} disabled={dis} />
          {chosen && !chosen.active && <small style={{ color: '#b35f00' }}>transportadora inativa</small>}
          {chosen && specialTransportCompany(chosen) === 'to_define' && <small style={{ color: '#b35f00' }}>“A definir”: lembre de escolher a transportadora antes de confirmar o pedido.</small>}
        </label>
        <label className="field" title="CFOP principal do pedido (natureza da operação na NF-e). Uso interno/fiscal: não sai nos PDFs do cliente.">
          CFOP do pedido
          <input
            value={cfop}
            onChange={(e) => setCfop(e.target.value)}
            onBlur={() => cfopNorm && !cfopErr && setCfop(cfopNorm)}
            disabled={dis}
            placeholder={exportArea ? `ex.: ${CFOP_PLACEHOLDER}` : 'ex.: 5.101'}
            maxLength={8}
            inputMode="decimal"
            style={{ borderColor: cfopErr ? 'var(--crit)' : undefined }}
          />
          {cfopErr ? (
            <small style={{ color: 'var(--crit)' }}>{cfopErr}</small>
          ) : cfopWarn ? (
            <small style={{ color: '#b35f00' }}>{cfopWarn}</small>
          ) : (
            <small className="muted">vale para todas as unidades do pedido · uso interno, não sai nos PDFs do cliente</small>
          )}
        </label>
        {exportArea && (
          <>
            <label className="field" title="Agente desta carga: a comissão dele (por família de produto) entra no preço. Vem do cadastro do cliente; pode ser trocado por carga.">
              Agente (comissão no preço)
              <select value={agent} onChange={(e) => void chooseAgent(e.target.value)} disabled={dis}>
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
              <input inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} disabled={dis} placeholder="0,00" style={{ borderColor: Number.isNaN(f) ? 'var(--crit)' : undefined }} />
              {multi && <small className="muted">só desta unidade</small>}
            </label>
            <label className="field">
              Seguro (USD)
              <input inputMode="decimal" value={insurance} onChange={(e) => setInsurance(e.target.value)} disabled={dis} placeholder="0,00" style={{ borderColor: Number.isNaN(i) ? 'var(--crit)' : undefined }} />
              {multi && <small className="muted">só desta unidade</small>}
            </label>
          </>
        )}
      </div>
      {exportArea && (
        <>
          <p className="muted" style={{ margin: '4px 0' }}>
            Incoterm {p.incoterm ?? '—'} · mercadoria {p.goodsUsd != null ? `USD ${usd.format(p.goodsUsd)}` : 'sem preço'}
            {tot.freightUsd ? ` + frete USD ${usd.format(tot.freightUsd)}` : ''}
            {tot.insuranceUsd ? ` + seguro USD ${usd.format(tot.insuranceUsd)}` : ''}
            {(tot.freightUsd || tot.insuranceUsd) && tot.totalUsd != null ? ` = total USD ${usd.format(tot.totalUsd)}` : ''}
            <span> · o PDF mostra o subtotal da mercadoria, o frete, o seguro e o total geral (cada valor somado uma única vez).</span>
          </p>
          <PaymentTermsFields value={terms} onChange={setTerms} disabled={dis} idPrefix={`pt-${p.planId}`} />
          {multi && p.editable && (
            <small className={p.termsDiffer ? undefined : 'muted'} style={{ display: 'block', color: p.termsDiffer ? '#b35f00' : undefined }}>
              {p.termsDiffer
                ? 'As outras unidades deste pedido têm outra condição de pagamento; ao salvar, a desta unidade passa a valer para todas.'
                : `A condição de pagamento vale para todas as unidades do pedido (${p.orderUnits}).`}
            </small>
          )}
        </>
      )}
      {multi && p.editable && (
        <>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} disabled={busy} />
            Aplicar a transportadora a todas as unidades deste pedido ({p.orderUnits})
          </label>
          {p.carrierDiffers && <small style={{ display: 'block', color: '#b35f00' }}>As outras unidades deste pedido têm outra transportadora; marcar substitui a delas.</small>}
          {/* inativa só continua onde já estava: o servidor recusa levá-la às outras unidades */}
          {applyAll && p.carrierDiffers && chosen && !chosen.active && (
            <small style={{ display: 'block', color: 'var(--crit)' }}>Transportadora inativa não pode ser aplicada às outras unidades: escolha uma ativa ou desmarque a opção.</small>
          )}
        </>
      )}
      {msg && <div className={`alert ${msg.type}`} style={{ marginTop: 6 }}>{msg.text}</div>}
      {p.editable && (
        <button className="primary" style={{ marginTop: 8 }} disabled={busy || termErrors.length > 0 || Number.isNaN(f) || Number.isNaN(i) || Boolean(cfopErr)} onClick={() => void save()}>
          {busy ? 'Salvando…' : exportArea ? 'Salvar proforma, transporte e fiscal' : 'Salvar transporte e fiscal'}
        </button>
      )}
    </details>
  )
}
