'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { bandPriceKey, roundUpUsd, brandKey, commissionKey, commissionOutsideUsual, commissionRateFor, COMMISSION_USUAL, FamilyRule, listUnitPrice, methodUsesFixed, methodUsesKg, PRICE_METHOD_LABEL, PriceBand, PriceMethod, priceKey, PriceTwin, quoteLineTotal } from '@/domain/exportPricing'
import { IssuedQuote, QuoteRow } from '@/components/quotes/QuoteView'
import { dayBR } from '@/components/format'
import { countryNamePt } from '@/lib/countries'
import { parseMoney } from '@/domain/paymentTerms'
import { PriceListButton } from './PriceListDialog'
import type { FamilyTech } from '@/domain/technology'
import type { PriceListItem } from '@/lib/priceList'
import { saveCategoryAction, setBrandAdjustAction, setCommissionAction, setFamilyBandPricesAction, setFamilyCifAction, setCountryCategoryAction, setFamilyMethodAction, setFamilyPriceAction } from './actions'

interface Category { id: number; code: string; name: string; sort: number; active: boolean }
interface Country { code: string; name: string; categoryId: number | null }
interface FamilyRow {
  id: number
  name: string
  /** tecnologia comercial do Catálogo (PACIFIL NXT) */
  tech: FamilyTech | null
  method: PriceMethod
  refFamilyId: number | null
  markupPct: number | null
  cifUsdPerKg: number | null
  prices: { categoryId: number; usdPerKg: number | null; fixedUsdPerUnit: number | null; updated: string }[]
  /** faixas de diâmetro com USD/kg próprio (Silo-bolsa); vazio = um USD/kg por categoria */
  bands: PriceBand[]
  bandPrices: { categoryId: number; bandKey: string; usdPerKg: number | null; at: string; updated: string }[]
}
interface Product { sku: string; name: string; brand: string | null; familyId: number; family: string; netKg: number | null }
interface BrandRow { brand: string; pct: number; products: number; updated: string | null }
interface Agent { id: number; name: string; active: boolean }
interface CommissionRow { agentId: number; familyId: number; pct: number; updated: string }
interface HistoryRow { id: number; at: string; user: string; kind: string; familyId: number | null; categoryId: number | null; countryCode: string | null; field: string; oldValue: string | null; newValue: string | null }

type Tab = 'cotacoes' | 'precos' | 'marcas' | 'comissoes' | 'paises' | 'categorias' | 'produtos' | 'historico'
const TABS: [Tab, string][] = [
  ['precos', 'Preços por família'],
  ['marcas', 'Ajuste por marca'],
  ['comissoes', 'Comissões de agente'],
  ['paises', 'Países por categoria'],
  ['categorias', 'Categorias de mercado'],
  ['produtos', 'Preços dos produtos'],
  ['cotacoes', 'Cotações emitidas'],
  ['historico', 'Histórico'],
]
const usd = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const usd2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kgf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const numIn = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))

export function ExportPricesClient(p: { canEdit: boolean; categories: Category[]; countries: Country[]; families: FamilyRow[]; products: Product[]; brands: BrandRow[]; agents: Agent[]; commissions: CommissionRow[]; quotes: IssuedQuote[]; listItems: PriceListItem[]; priceTwin: [string, PriceTwin | null][]; skuDiameterFt: [string, number][]; history: HistoryRow[] }) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('precos')
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const active = p.categories.filter((c) => c.active)

  async function act(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, okText: string): Promise<boolean> {
    setBusy(true)
    setMsg(null)
    const r = await fn().catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) {
      setMsg({ type: 'error', text: r.error })
      return false
    }
    setMsg({ type: 'ok', text: okText })
    router.refresh()
    return true
  }

  return (
    <>
      <div className="page-head">
        <h1>Preços de exportação</h1>
        <span className="muted">Preço em USD por kg LÍQUIDO (só o produto), por família e categoria de mercado. Peso, família e demais dados vêm do catálogo mestre.</span>
        <span className="spacer" />
        <PriceListButton items={p.listItems} families={p.families.filter((f) => f.method !== 'INCLUDED').map((f) => ({ id: f.id, name: f.name, tech: f.tech }))} categories={active.map((c) => ({ id: c.id, name: c.name }))} agents={p.agents.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name }))} />
      </div>
      {!p.canEdit && <div className="alert warn">Somente leitura: preços são editados por gerente ou administrador.</div>}
      <div className="row" style={{ gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      {tab === 'precos' && <FamilyPrices {...p} active={active} busy={busy} act={act} />}
      {tab === 'marcas' && <Brands {...p} busy={busy} act={act} />}
      {tab === 'comissoes' && <Commissions {...p} busy={busy} act={act} />}
      {tab === 'paises' && <Countries {...p} active={active} busy={busy} act={act} />}
      {tab === 'categorias' && <Categories {...p} busy={busy} act={act} />}
      {tab === 'produtos' && <ProductPrices {...p} active={active} />}
      {tab === 'cotacoes' && <Quotes quotes={p.quotes} />}
      {tab === 'historico' && <History {...p} />}
    </>
  )
}

type Act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, okText: string) => Promise<boolean>

/** Matriz família × categoria: regra da família e USD/kg (+ fixo USD/unidade quando a regra pede). */
function FamilyPrices({ families, active, canEdit, busy, act }: { families: FamilyRow[]; active: Category[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [edit, setEdit] = useState<Record<string, { kg: string; fixed: string }>>({})
  const [bandEdit, setBandEdit] = useState<Record<string, Record<string, string>>>({})
  const [cifEdit, setCifEdit] = useState<Record<string, string>>({})
  const cell = (f: FamilyRow, c: Category) => {
    const k = priceKey(f.id, c.id)
    const cur = f.prices.find((x) => x.categoryId === c.id)
    return { k, cur, v: edit[k] ?? { kg: numIn(cur?.usdPerKg), fixed: numIn(cur?.fixedUsdPerUnit) } }
  }
  if (!active.length) return <div className="alert warn">Nenhuma categoria ativa. Cadastre as categorias em “Categorias de mercado”.</div>
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div style={{ marginBottom: 8 }}>
        <small className="muted">
          Recargo CIF (só em cotações CIF): peso líquido × recargo da família (última coluna), somado ao preço (depois do ajuste da marca; o fixo por unidade continua). Família sem recargo fica sem preço em CIF.
        </small>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Família</th>
            <th>Regra de preço</th>
            {active.map((c) => (
              <th key={c.id} className="num" title={c.name}>
                {c.name}
              </th>
            ))}
            <th className="num" title="Recargo CIF da família (USD por kg líquido), só em cotações CIF. Vazio = a família fica sem preço em CIF">
              Recargo CIF USD/kg
            </th>
          </tr>
        </thead>
        <tbody>
          {families.map((f) => (
            <tr key={f.id}>
              <td>
                <strong>{f.name}</strong>
              </td>
              <td>
                <RuleEditor f={f} families={families} canEdit={canEdit} busy={busy} act={act} />
              </td>
              {active.map((c) => {
                const { k, cur, v } = cell(f, c)
                if (f.method === 'RELATIVE')
                  return (
                    <td key={c.id} className="num muted" title="Calculado automaticamente a partir da família de referência">
                      = {families.find((x) => x.id === f.refFamilyId)?.name ?? '?'} + {numIn(f.markupPct)}%
                    </td>
                  )
                if (!methodUsesKg(f.method))
                  return (
                    <td key={c.id} className="num muted">
                      incluído (0)
                    </td>
                  )
                if (f.bands.length) {
                  // faixas de diâmetro: um USD/kg por faixa (+ o fixo por unidade da família, se a regra pedir)
                  const saved = (b: PriceBand) => numIn(f.bandPrices.find((x) => x.categoryId === c.id && x.bandKey === b.key)?.usdPerKg)
                  const vals = bandEdit[k] ?? Object.fromEntries(f.bands.map((b) => [b.key, saved(b)]))
                  const bandDirty = bandEdit[k] != null && f.bands.some((b) => (vals[b.key] ?? '') !== saved(b))
                  const fixedDirty = methodUsesFixed(f.method) && edit[k] != null && v.fixed !== numIn(cur?.fixedUsdPerUnit)
                  const anyDirty = bandDirty || fixedDirty
                  const last = f.bandPrices.filter((x) => x.categoryId === c.id).sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.updated
                  return (
                    <td key={c.id} className="num" style={{ whiteSpace: 'nowrap' }}>
                      {f.bands.map((b) => (
                        <label key={b.key} title={`USD por kg líquido · diâmetro ${numIn(b.minFt)}${b.maxFt !== b.minFt ? ` a ${numIn(b.maxFt)}` : ''} pés`} style={{ display: 'block', marginTop: 2 }}>
                          <small className="muted">{b.label}</small>{' '}
                          <input style={{ width: 62, textAlign: 'right' }} inputMode="decimal" value={vals[b.key] ?? ''} disabled={!canEdit || busy} placeholder="—" onChange={(e) => setBandEdit({ ...bandEdit, [k]: { ...vals, [b.key]: e.target.value } })} />{' '}
                          <small className="muted">USD/kg</small>
                        </label>
                      ))}
                      {methodUsesFixed(f.method) && (
                        <label title="Valor fixo por unidade (válvulas e acessórios), o mesmo em todas as faixas" style={{ display: 'block', marginTop: 2 }}>
                          + <input style={{ width: 62, textAlign: 'right' }} inputMode="decimal" value={v.fixed} disabled={!canEdit || busy} placeholder="—" onChange={(e) => setEdit({ ...edit, [k]: { ...v, fixed: e.target.value } })} />{' '}
                          <small className="muted">USD/un.</small>
                        </label>
                      )}
                      {anyDirty && (
                        <button
                          className="small primary"
                          style={{ marginTop: 2 }}
                          disabled={busy}
                          onClick={async () => {
                            // faixas (USD/kg) e, se mudou, o fixo por unidade da família (o USD/kg da família fica como está)
                            const okBands = bandDirty ? await act(() => setFamilyBandPricesAction(f.id, c.id, vals), `Preços por diâmetro de ${f.name} · ${c.name} salvos.`) : true
                            if (okBands) setBandEdit((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== k)))
                            if (okBands && fixedDirty && (await act(() => setFamilyPriceAction(f.id, c.id, numIn(cur?.usdPerKg), v.fixed), `Valor fixo de ${f.name} · ${c.name} salvo.`)))
                              setEdit((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== k)))
                          }}
                        >
                          Salvar
                        </button>
                      )}
                      {last && !anyDirty && <small className="muted" style={{ display: 'block', fontSize: 10 }}>{last}</small>}
                    </td>
                  )
                }
                const dirty = edit[k] != null && (v.kg !== numIn(cur?.usdPerKg) || v.fixed !== numIn(cur?.fixedUsdPerUnit))
                return (
                  <td key={c.id} className="num" style={{ whiteSpace: 'nowrap' }}>
                    <label title="USD por kg líquido">
                      <input style={{ width: 70, textAlign: 'right' }} inputMode="decimal" value={v.kg} disabled={!canEdit || busy} placeholder="—" onChange={(e) => setEdit({ ...edit, [k]: { ...v, kg: e.target.value } })} />{' '}
                      <small className="muted">USD/kg</small>
                    </label>
                    {methodUsesFixed(f.method) && (
                      <label title="Valor fixo por unidade (válvulas e acessórios)" style={{ display: 'block', marginTop: 2 }}>
                        + <input style={{ width: 62, textAlign: 'right' }} inputMode="decimal" value={v.fixed} disabled={!canEdit || busy} placeholder="—" onChange={(e) => setEdit({ ...edit, [k]: { ...v, fixed: e.target.value } })} />{' '}
                        <small className="muted">USD/un.</small>
                      </label>
                    )}
                    {dirty && (
                      <button
                        className="small primary"
                        style={{ marginTop: 2 }}
                        disabled={busy}
                        onClick={() =>
                          void act(() => setFamilyPriceAction(f.id, c.id, v.kg, methodUsesFixed(f.method) ? v.fixed : ''), `Preço de ${f.name} · ${c.name} salvo.`).then(() => {
                            setEdit((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== k)))
                          })
                        }
                      >
                        Salvar
                      </button>
                    )}
                    {cur && !dirty && <small className="muted" style={{ display: 'block', fontSize: 10 }}>{cur.updated}</small>}
                  </td>
                )
              })}
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {f.method === 'INCLUDED' ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    <input
                      style={{ width: 62, textAlign: 'right' }}
                      inputMode="decimal"
                      placeholder="—"
                      value={cifEdit[f.id] ?? numIn(f.cifUsdPerKg)}
                      disabled={!canEdit || busy}
                      onChange={(e) => setCifEdit({ ...cifEdit, [f.id]: e.target.value })}
                    />
                    {cifEdit[f.id] != null && cifEdit[f.id] !== numIn(f.cifUsdPerKg) && (
                      <button className="small primary" style={{ marginLeft: 4 }} disabled={busy} onClick={() => void act(() => setFamilyCifAction(f.id, cifEdit[f.id]), `Recargo CIF de ${f.name} salvo.`).then(() => setCifEdit((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== String(f.id)))))}>
                        Salvar
                      </button>
                    )}
                    {f.cifUsdPerKg == null && cifEdit[f.id] == null && (
                      <small style={{ display: 'block', fontSize: 10, color: 'var(--warn)' }} title="Sem recargo CIF a família fica sem preço em cotações CIF">
                        obrigatório p/ cotar CIF
                      </small>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <small className="muted">
        Preço unitário = peso líquido do produto (catálogo) × USD/kg{' '}
        <span>· na regra com valor fixo: + USD/unidade (válvulas e acessórios). Vazio = sem preço (o sistema avisa “sem preço”).</span>{' '}
        <span>· Silo-bolsa: USD/kg pela faixa de diâmetro do produto; diâmetro fora das faixas usa a faixa de centro mais próximo (8,5 pés → 5 a 8; 13 pés → 14).</span>
      </small>
    </div>
  )
}

/** Regra da família; "% sobre outra família" pede a família de referência e o acréscimo. */
function RuleEditor({ f, families, canEdit, busy, act }: { f: FamilyRow; families: FamilyRow[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [draft, setDraft] = useState<{ method: PriceMethod; ref: number | null; pct: string } | null>(null)
  const d = draft ?? { method: f.method, ref: f.refFamilyId, pct: numIn(f.markupPct) }
  const refs = families.filter((x) => x.id !== f.id && x.method !== 'RELATIVE' && x.method !== 'INCLUDED')
  const save = (next: { method: PriceMethod; ref: number | null; pct: string }) =>
    void act(() => setFamilyMethodAction(f.id, next.method, { refFamilyId: next.ref, markupPct: next.pct }), `Regra de ${f.name} alterada.`).then(() => setDraft(null))
  return (
    <div>
      <select
        value={d.method}
        disabled={!canEdit || busy}
        onChange={(e) => {
          const m = e.target.value as PriceMethod
          // a regra relativa só é salva com a família de referência e o %
          if (m === 'RELATIVE') setDraft({ method: m, ref: d.ref ?? refs[0]?.id ?? null, pct: d.pct })
          else save({ method: m, ref: null, pct: '' })
        }}
      >
        {(Object.keys(PRICE_METHOD_LABEL) as PriceMethod[]).map((m) => (
          <option key={m} value={m}>
            {PRICE_METHOD_LABEL[m]}
          </option>
        ))}
      </select>
      {d.method === 'RELATIVE' && (
        <div style={{ marginTop: 4, whiteSpace: 'nowrap' }}>
          <select value={d.ref ?? ''} disabled={!canEdit || busy} onChange={(e) => setDraft({ ...d, ref: Number(e.target.value) })}>
            {refs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>{' '}
          +{' '}
          <input style={{ width: 52, textAlign: 'right' }} inputMode="decimal" value={d.pct} disabled={!canEdit || busy} onChange={(e) => setDraft({ ...d, pct: e.target.value })} /> %
          {draft && (
            <button className="small primary" style={{ marginLeft: 4 }} disabled={busy || !d.ref || !d.pct.trim()} onClick={() => save(d)}>
              Salvar
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Ajuste % de cada marca sobre o preço de lista (ex.: Ecobag −5%), para qualquer família. */
function Brands({ brands, canEdit, busy, act }: { brands: BrandRow[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [edit, setEdit] = useState<Record<string, string>>({})
  return (
    <div className="panel">
      <table className="data compact">
        <thead>
          <tr>
            <th>Marca</th>
            <th className="num">Produtos</th>
            <th className="num">Ajuste sobre o preço de lista</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {brands.map((b) => {
            const v = edit[b.brand] ?? numIn(b.pct || null)
            const dirty = edit[b.brand] != null && v !== numIn(b.pct || null)
            return (
              <tr key={b.brand}>
                <td>
                  <strong>{b.brand}</strong>
                </td>
                <td className="num">{b.products}</td>
                <td className="num">
                  <input style={{ width: 64, textAlign: 'right' }} inputMode="decimal" placeholder="0" value={v} disabled={!canEdit || busy} onChange={(e) => setEdit({ ...edit, [b.brand]: e.target.value })} /> %
                  {b.updated && !dirty && <small className="muted" style={{ display: 'block', fontSize: 10 }}>{b.updated}</small>}
                </td>
                <td>
                  {dirty && (
                    <button className="small primary" disabled={busy} onClick={() => void act(() => setBrandAdjustAction(b.brand, v), `Ajuste da marca ${b.brand} salvo.`).then(() => setEdit((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== b.brand))))}>
                      Salvar
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <small className="muted">Negativo = desconto (ex.: −5 = 5% abaixo do preço de lista). Vale para todas as famílias e mercados; na cotização o preço ainda pode ser alterado manualmente.</small>
    </div>
  )
}

/** Perfil de cada agente: % de comissão por família (o país não influi). Família sem % = sem comissão definida. */
function Commissions({ families, agents, commissions, canEdit, busy, act }: { families: FamilyRow[]; agents: Agent[]; commissions: CommissionRow[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [agentId, setAgentId] = useState<number | null>(agents[0]?.id ?? null)
  const [edit, setEdit] = useState<Record<string, string>>({})
  const priced = families.filter((f) => f.method !== 'INCLUDED')
  const agent = agents.find((a) => a.id === agentId)
  if (!agents.length) return <div className="alert warn">Nenhum agente cadastrado. Cadastre os agentes em Cadastros → Agentes e volte aqui para definir a comissão de cada um.</div>
  return (
    <div className="panel">
      <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          Agente{' '}
          <select value={agentId ?? ''} onChange={(e) => (setAgentId(Number(e.target.value)), setEdit({}))}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.active ? '' : ' (inativo)'}
              </option>
            ))}
          </select>
        </label>
        <small className="muted">
          Comissão = % do preço FINAL faturado: preço = base ÷ (1 − %). Faixa usual {COMMISSION_USUAL.min}–{COMMISSION_USUAL.max}% (fora dela o sistema avisa). Família sem % = sem comissão definida (o sistema avisa e não calcula).
        </small>
      </div>
      {agent && (
        <table className="data compact" style={{ maxWidth: 560 }}>
          <thead>
            <tr>
              <th>Família</th>
              <th className="num">Comissão de {agent.name}</th>
            </tr>
          </thead>
          <tbody>
            {priced.map((f) => {
              const k = commissionKey(agent.id, f.id)
              const cur = commissions.find((x) => x.agentId === agent.id && x.familyId === f.id)
              const v = edit[k] ?? numIn(cur?.pct)
              const dirty = edit[k] != null && v !== numIn(cur?.pct)
              const n = v.trim() === '' ? null : Number(v.replace(',', '.'))
              return (
                <tr key={f.id}>
                  <td>
                    <strong>{f.name}</strong>
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <input style={{ width: 60, textAlign: 'right', borderColor: commissionOutsideUsual(n) ? '#b35f00' : undefined }} inputMode="decimal" placeholder="—" value={v} disabled={!canEdit || busy} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /> %
                    {dirty && (
                      <button className="small primary" style={{ marginLeft: 4 }} disabled={busy} onClick={() => void act(() => setCommissionAction(agent.id, f.id, v), `Comissão de ${agent.name} · ${f.name} salva.`).then(() => setEdit((e) => Object.fromEntries(Object.entries(e).filter(([x]) => x !== k))))}>
                        Salvar
                      </button>
                    )}
                    {commissionOutsideUsual(n) && <small style={{ display: 'block', color: '#b35f00', fontSize: 10 }}>fora de {COMMISSION_USUAL.min}–{COMMISSION_USUAL.max}%</small>}
                    {cur && !dirty && <small className="muted" style={{ display: 'block', fontSize: 10 }}>{cur.updated}</small>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Cada país numa categoria (ou sem categoria = sem preço). */
function Countries({ countries, active, categories, canEdit, busy, act }: { countries: Country[]; active: Category[]; categories: Category[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [q, setQ] = useState('')
  const [extra, setExtra] = useState('')
  const shown = countries.filter((c) => !q || `${c.name} ${c.code}`.toLowerCase().includes(q.toLowerCase()))
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name
  return (
    <div className="panel">
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input placeholder="Buscar país…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <span className="muted">País sem categoria = sem preço (o sistema avisa).</span>
        <span className="spacer" />
        {canEdit && (
          <>
            <input placeholder="Outro país (código ISO, ex.: KE)" value={extra} onChange={(e) => setExtra(e.target.value.toUpperCase().slice(0, 2))} style={{ width: 200 }} />
            <select
              disabled={busy || !/^[A-Z]{2}$/.test(extra)}
              value=""
              onChange={(e) => e.target.value && void act(() => setCountryCategoryAction(extra, Number(e.target.value)), `País ${extra} atribuído.`).then(() => setExtra(''))}
            >
              <option value="">atribuir a…</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <table className="data compact">
        <thead>
          <tr>
            <th>País</th>
            <th>Código</th>
            <th>Categoria</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.code}>
              <td>
                {/* eslint-disable-next-line @next/next/no-img-element -- bandeira externa pequena */}
                <img src={`https://flagcdn.com/w20/${c.code.toLowerCase()}.png`} alt="" width={20} height={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                {c.name}
              </td>
              <td>{c.code}</td>
              <td>
                <select
                  value={c.categoryId ?? ''}
                  disabled={!canEdit || busy}
                  onChange={(e) => void act(() => setCountryCategoryAction(c.code, e.target.value ? Number(e.target.value) : null), `${c.name}: ${e.target.value ? catName(Number(e.target.value)) : 'sem categoria'}.`)}
                  style={{ color: c.categoryId ? undefined : 'var(--crit)' }}
                >
                  <option value="">— sem categoria (sem preço) —</option>
                  {categories.map((k) => (
                    <option key={k.id} value={k.id} disabled={!k.active && k.id !== c.categoryId}>
                      {k.name}
                      {k.active ? '' : ' (inativa)'}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Categorias de mercado: código, nome, ordem e ativa. */
function Categories({ categories, countries, canEdit, busy, act }: { categories: Category[]; countries: Country[]; canEdit: boolean; busy: boolean; act: Act }) {
  const [rows, setRows] = useState<Record<number, Category>>({})
  const [novo, setNovo] = useState({ code: '', name: '' })
  return (
    <div className="panel">
      <table className="data compact">
        <thead>
          <tr>
            <th>Código</th>
            <th>Nome</th>
            <th className="num">Ordem</th>
            <th>Ativa</th>
            <th className="num">Países</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {categories.map((c0) => {
            const c = rows[c0.id] ?? c0
            const set = (x: Partial<Category>) => setRows({ ...rows, [c0.id]: { ...c, ...x } })
            const dirty = rows[c0.id] != null && JSON.stringify(rows[c0.id]) !== JSON.stringify(c0)
            return (
              <tr key={c0.id}>
                <td>
                  <input value={c.code} disabled={!canEdit} onChange={(e) => set({ code: e.target.value })} style={{ width: 60 }} />
                </td>
                <td>
                  <input value={c.name} disabled={!canEdit} onChange={(e) => set({ name: e.target.value })} style={{ width: 300 }} />
                </td>
                <td className="num">
                  <input type="number" value={c.sort} disabled={!canEdit} onChange={(e) => set({ sort: Number(e.target.value) })} style={{ width: 60 }} />
                </td>
                <td>
                  <input type="checkbox" checked={c.active} disabled={!canEdit} onChange={(e) => set({ active: e.target.checked })} />
                </td>
                <td className="num">{countries.filter((x) => x.categoryId === c0.id).length}</td>
                <td>
                  {dirty && (
                    <button className="small primary" disabled={busy} onClick={() => void act(() => saveCategoryAction(c), `Categoria ${c.code} salva.`).then(() => setRows((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== String(c0.id)))))}>
                      Salvar
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {canEdit && (
            <tr>
              <td>
                <input placeholder="D" value={novo.code} onChange={(e) => setNovo({ ...novo, code: e.target.value })} style={{ width: 60 }} />
              </td>
              <td>
                <input placeholder="Nome da nova categoria" value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} style={{ width: 300 }} />
              </td>
              <td colSpan={3} />
              <td>
                <button
                  className="small"
                  disabled={busy || !novo.code.trim() || !novo.name.trim()}
                  onClick={() => void act(() => saveCategoryAction({ ...novo, sort: categories.length + 1, active: true }), `Categoria ${novo.code.toUpperCase()} criada.`).then(() => setNovo({ code: '', name: '' }))}
                >
                  + Adicionar
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <small className="muted">Desativar uma categoria tira o preço dos países dela (sem apagar os valores nem o histórico).</small>
    </div>
  )
}

/** Preço unitário resultante de cada produto do catálogo (peso líquido atual) numa categoria; simulação com preço manual. */
function ProductPrices({ products, families, active, brands, agents, commissions, priceTwin, skuDiameterFt }: { products: Product[]; families: FamilyRow[]; active: Category[]; brands: BrandRow[]; agents: Agent[]; commissions: CommissionRow[]; priceTwin: [string, PriceTwin | null][]; skuDiameterFt: [string, number][] }) {
  const [incoterm, setIncoterm] = useState('FOB')
  const [agent, setAgent] = useState<number | 'none' | 'manual'>('none')
  const [manualPct, setManualPct] = useState('')
  const [catId, setCatId] = useState<number | null>(active[0]?.id ?? null)
  const [fam, setFam] = useState<number | 'all'>('all')
  const [q, setQ] = useState('')
  const [manual, setManual] = useState<Record<string, string>>({})
  const byFamily = useMemo(() => new Map(families.map((f) => [f.id, f])), [families])
  const cfg = useMemo(
    () => ({
      familyRule: new Map<number, FamilyRule>(families.map((f) => [f.id, { method: f.method, refFamilyId: f.refFamilyId, markupPct: f.markupPct, cifUsdPerKg: f.cifUsdPerKg }])),
      brandAdjust: new Map(brands.filter((b) => b.pct).map((b) => [brandKey(b.brand), b.pct])),
      commission: new Map(commissions.map((c) => [commissionKey(c.agentId, c.familyId), c.pct])),
      familyPrice: new Map(families.flatMap((f) => f.prices.map((x) => [priceKey(f.id, x.categoryId), { usdPerKg: x.usdPerKg, fixedUsdPerUnit: x.fixedUsdPerUnit }] as const))),
      // Hidrosilo / Hidroforce de 3 m: preço do Hidrosilo de 2 m da mesma capacidade
      priceTwin: new Map(priceTwin),
      // Silo-bolsa: USD/kg pela faixa de diâmetro
      familyBands: new Map(families.filter((f) => f.bands.length).map((f) => [f.id, f.bands] as const)),
      bandPrice: new Map(families.flatMap((f) => f.bandPrices.filter((x) => x.usdPerKg != null).map((x) => [bandPriceKey(f.id, x.categoryId, x.bandKey), x.usdPerKg!] as const))),
      skuDiameterFt: new Map(skuDiameterFt),
    }),
    [families, brands, commissions, priceTwin, skuDiameterFt],
  )
  const rows = products.filter((x) => (fam === 'all' || x.familyId === fam) && (!q || `${x.sku} ${x.name}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Categoria{' '}
          <select value={catId ?? ''} onChange={(e) => setCatId(Number(e.target.value))}>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Família{' '}
          <select value={fam} onChange={(e) => setFam(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Todas</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <input placeholder="Buscar produto…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <label title="CIF soma o recargo por kg líquido ao preço">
          Incoterm{' '}
          <select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
            <option value="FOB">FOB / demais</option>
            <option value="CIF">CIF</option>
          </select>
        </label>
        <label title="Comissão incluída no preço (% do preço final)">
          Venda via agente{' '}
          <select value={String(agent)} onChange={(e) => setAgent(e.target.value === 'none' || e.target.value === 'manual' ? e.target.value : Number(e.target.value))}>
            <option value="none">Não</option>
            {agents
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            <option value="manual">% manual…</option>
          </select>
        </label>
        {agent === 'manual' && (
          <span>
            <input style={{ width: 56, textAlign: 'right' }} inputMode="decimal" value={manualPct} onChange={(e) => setManualPct(e.target.value)} /> %
          </span>
        )}
        <small className="muted">Preço manual: só para simular uma cotização — não altera a tabela. * valores da família de referência (regra %).</small>
      </div>
      <table className="data compact">
        <thead>
          <tr>
            <th>Código</th>
            <th>Descrição</th>
            <th>Família</th>
            <th className="num">Peso líquido kg</th>
            <th className="num">USD/kg</th>
            <th className="num">Fixo USD/un.</th>
            <th className="num">Preço unitário USD</th>
            {agent !== 'none' && <th className="num">Comissão</th>}
            {agent !== 'none' && <th className="num">Preço c/ comissão USD</th>}
            <th className="num">Preço manual (simulação)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const f = byFamily.get(x.familyId)
            const method = f?.method ?? 'PER_KG'
            const pr = f?.prices.find((y) => y.categoryId === catId)
            const r = catId == null ? ({ ok: false, reason: 'sem categoria' } as const) : listUnitPrice(cfg, x, catId, incoterm)
            const ref = method === 'RELATIVE' ? byFamily.get(f?.refFamilyId ?? -1) : undefined
            const refPr = ref?.prices.find((y) => y.categoryId === catId)
            const m = manual[x.sku] ?? ''
            const mv = parseMoney(m)
            const mp = manualPct.trim() === '' ? null : Number(manualPct.replace(',', '.'))
            const rate = agent === 'none' || catId == null || method === 'INCLUDED' ? (agent !== 'none' && method === 'INCLUDED' ? { pct: 0, source: 'incluído' } : null) : agent === 'manual' ? (mp != null && Number.isFinite(mp) ? { pct: mp, source: 'manual' } : null) : commissionRateFor(cfg, agent, x.familyId)
            const line = quoteLineTotal({ sku: x.sku, quantity: 1, calculatedUnitUsd: r.ok ? r.unitUsd : null, commissionPct: rate?.pct ?? null, overrideUnitUsd: mv != null && Number.isFinite(mv) ? mv : null })
            const withCom = r.ok && rate ? quoteLineTotal({ sku: x.sku, quantity: 1, calculatedUnitUsd: r.unitUsd, commissionPct: rate.pct }) : null
            return (
              <tr key={x.sku}>
                <td>{x.sku}</td>
                <td>{x.name}</td>
                <td>{x.family}</td>
                <td className="num">{x.netKg != null ? kgf.format(x.netKg) : '—'}</td>
                <td className="num">
                  {method === 'INCLUDED'
                    ? '—'
                    : r.ok && r.band
                      ? `${usd.format(r.usdPerKg ?? 0)}${method === 'RELATIVE' ? '*' : ''}`
                      : (method === 'RELATIVE' ? ref : f)?.bands.length
                        ? '—'
                        : method === 'RELATIVE'
                          ? refPr?.usdPerKg != null
                            ? `${usd.format(refPr.usdPerKg)}*`
                            : '—'
                          : pr?.usdPerKg != null
                            ? usd.format(pr.usdPerKg)
                            : '—'}
                  {r.ok && r.band && (
                    <small className="muted" style={{ display: 'block' }} title={r.band.nearest ? `Diâmetro ${numIn(r.band.diameterFt)} pés fora das faixas: usa a de centro mais próximo` : undefined}>
                      {r.band.label}
                      {r.band.nearest ? ' *' : ''}
                    </small>
                  )}
                </td>
                <td className="num">{method === 'RELATIVE' ? (ref && methodUsesFixed(ref.method) && refPr?.fixedUsdPerUnit != null ? `${usd.format(refPr.fixedUsdPerUnit)}*` : '') : methodUsesFixed(method) ? (pr?.fixedUsdPerUnit != null ? usd.format(pr.fixedUsdPerUnit) : '—') : ''}</td>
                <td className="num">
                  {r.ok ? (
                    <>
                    <strong
                      title={
                        (r.priceAs ? `= ${r.priceAs.sku} (Hidrosilo 2 m, mesma capacidade, ${kgf.format(r.priceAs.netKg)} kg) · ` : '') +
                        (method === 'INCLUDED'
                          ? 'Incluído no valor de outro produto'
                          : r.listUnitUsd != null
                            ? `lista ${usd2.format(r.listUnitUsd)} ${(r.brandAdjustPct ?? 0) > 0 ? '+' : ''}${numIn(r.brandAdjustPct ?? 0)}% (marca ${x.brand})`
                            : r.base
                            ? `${ref?.name ?? 'referência'} ${usd2.format(r.base.unitUsd)} + ${numIn(r.base.markupPct)}%`
                            : `${kgf.format(r.netKg)} kg × ${usd.format(r.usdPerKg ?? 0)}${r.fixedPart ? ` + ${usd2.format(r.fixedPart)}` : ''}`)
                      }
                    >
                      {usd2.format(roundUpUsd(r.unitUsd))}
                    </strong>
                    {roundUpUsd(r.unitUsd) !== r.unitUsd && <small className="muted" style={{ display: 'block' }}>calc. {usd2.format(r.unitUsd)}</small>}
                    {r.priceAs && <small className="muted" style={{ display: 'block' }}>= {r.priceAs.sku} (2 m)</small>}
                    </>
                  ) : null}
                  {r.ok && r.cifSurchargeUsd ? (
                    <small className="muted" style={{ display: 'block' }}>
                      CIF +{usd2.format(r.cifSurchargeUsd)} ({numIn(r.cifUsdPerKg ?? 0)}/kg)
                    </small>
                  ) : null}
                  {r.ok && r.brandAdjustPct != null ? (
                    <small className="muted" style={{ display: 'block' }}>
                      lista {usd2.format(r.listUnitUsd ?? 0)} · marca {numIn(r.brandAdjustPct)}%
                    </small>
                  ) : null}
                  {r.ok ? null : (
                    <span className="muted" title={r.reason}>
                      sem preço
                    </span>
                  )}
                </td>
                {agent !== 'none' && (
                  <td className="num" style={{ color: commissionOutsideUsual(rate?.pct) ? '#b35f00' : undefined }} title={rate ? `fonte: ${rate.source}` : 'sem % de comissão definido'}>
                    {rate ? `${numIn(rate.pct)}%` : <span className="muted">sem %</span>}
                  </td>
                )}
                {agent !== 'none' && (
                  <td className="num">
                    {withCom?.unitUsd != null ? (
                      <>
                        <strong>{usd2.format(withCom.unitUsd)}</strong>
                        <small className="muted" style={{ display: 'block' }}>agente {usd2.format(withCom.commissionUsd ?? 0)}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
                <td className="num">
                  <input style={{ width: 80, textAlign: 'right' }} inputMode="decimal" placeholder="—" value={m} onChange={(e) => setManual({ ...manual, [x.sku]: e.target.value })} />
                  {line.manual && line.unitUsd != null && <small className="muted" style={{ display: 'block' }}>usa {usd2.format(line.unitUsd)}</small>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Cotações emitidas (cada PDF de pedido gerado): busca por cliente, proforma, carga, produto, país ou
 * categoria e por período. Mostra categoria, comissão e o USD/kg principal; o detalhe abre na linha.
 */
function Quotes({ quotes }: { quotes: IssuedQuote[] }) {
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const shown = quotes.filter((x) => {
    // período pelo dia em São Paulo (como a data é exibida); a cotação entra se alguma emissão (primeira…última) cai no período
    const first = dayBR(x.firstIssuedAt)
    const last = dayBR(x.lastIssuedAt)
    if (from && last < from) return false
    if (to && first > to) return false
    if (!q.trim()) return true
    const hay = norm([x.planName, x.reference, x.customerName, x.orderRef, x.country, x.country ? countryNamePt(x.country) : null, x.category, x.agentName, x.transportCompany, x.incoterm, ...x.lines.map((l) => `${l.sku} ${l.name}`)].filter(Boolean).join(' '))
    return norm(q)
      .split(/\s+/)
      .every((w) => hay.includes(w))
  })
  return (
    <div className="panel">
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Buscar cliente, proforma, carga, produto, país…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <label>
          de <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          até <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted">
          {shown.length} de {quotes.length} · cada PDF com preço (cargas, paletes mistos e courier) fica registrado com o preço e como foi calculado
        </span>
      </div>
      {shown.length ? shown.map((x) => <QuoteRow key={x.id} q={x} showPlan />) : <div className="muted">Nenhuma cotação emitida {quotes.length ? 'com esse filtro' : 'ainda'}.</div>}
    </div>
  )
}

const fieldLabel = (f: string, agents: Agent[] = []) =>
  f.startsWith('usdPerKg:')
    ? `USD/kg faixa ${f.slice(9).replace('-', ' a ')} pés`
    : f.startsWith('brand:')
    ? `ajuste marca ${f.slice(6)} (%)`
    : f.startsWith('commission:')
      ? `comissão ${agents.find((a) => String(a.id) === f.slice(11))?.name ?? 'agente'} (%)`
      : FIELD[f] ?? f
const FIELD: Record<string, string> = { cifDefault: 'recargo CIF padrão (USD/kg)', cifUsdPerKg: 'recargo CIF (USD/kg)', usdPerKg: 'USD/kg', fixedUsdPerUnit: 'fixo USD/un.', method: 'regra', refFamilyId: 'família de referência', markupPct: 'acréscimo %', categoryId: 'categoria', code: 'código', name: 'nome', sort: 'ordem', active: 'ativa', created: 'criada' }

/** Histórico de alterações: data e hora, usuário, o que mudou, valor anterior → novo. */
function History({ history, families, categories, countries, agents }: { history: HistoryRow[]; families: FamilyRow[]; categories: Category[]; countries: Country[]; agents: Agent[] }) {
  const fam = (id: number | null) => families.find((f) => f.id === id)?.name ?? (id ? `família #${id}` : '')
  const cat = (id: number | string | null) => categories.find((c) => String(c.id) === String(id))?.name ?? (id ? `categoria #${id}` : '—')
  const country = (code: string | null) => countries.find((c) => c.code === code)?.name ?? code ?? ''
  const val = (h: HistoryRow, v: string | null) => {
    if (v == null) return '—'
    if (h.field === 'categoryId') return cat(v)
    if (h.field === 'refFamilyId') return fam(Number(v))
    if (h.field === 'method') return PRICE_METHOD_LABEL[v as PriceMethod] ?? v
    if (h.field === 'active') return v === 'true' ? 'sim' : 'não'
    return h.field === 'usdPerKg' || h.field.startsWith('usdPerKg:') || h.field === 'fixedUsdPerUnit' ? usd.format(Number(v)) : v
  }
  const what = (h: HistoryRow) =>
    h.kind === 'cif' ? (h.familyId ? `Recargo CIF · ${fam(h.familyId)}` : 'Recargo CIF padrão') : h.kind === 'cif_default' ? 'Recargo CIF padrão (extinto: agora só por família)' : h.kind === 'brand_adjust' ? 'Ajuste por marca' : h.kind === 'commission' ? `Comissão · ${fam(h.familyId)}` : h.kind === 'family_price' ? `${fam(h.familyId)} · ${cat(h.categoryId)}` : h.kind === 'family_rule' ? fam(h.familyId) : h.kind === 'country_category' ? country(h.countryCode) : `Categoria ${cat(h.categoryId)}`
  if (!history.length) return <div className="panel muted">Nenhuma alteração registrada ainda.</div>
  return (
    <div className="panel">
      <table className="data compact">
        <thead>
          <tr>
            <th>Data e hora</th>
            <th>Usuário</th>
            <th>Onde</th>
            <th>Campo</th>
            <th>Anterior</th>
            <th>Novo</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{h.at}</td>
              <td>{h.user}</td>
              <td>{what(h)}</td>
              <td>{fieldLabel(h.field, agents)}</td>
              <td className="num">{val(h, h.oldValue)}</td>
              <td className="num">
                <strong>{val(h, h.newValue)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
