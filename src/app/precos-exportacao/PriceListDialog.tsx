'use client'

import { useMemo, useState } from 'react'
import { DictationButton } from '@/components/DictationButton'
import { PdfPreview } from '@/components/pdf/PdfPreview'
import type { PriceListPreset } from '@/lib/ai/priceListAssistant'
import { priceListAssistAction } from './lista/actions'
import { BALANCE_WHEN_OPTIONS, BalanceWhen, balanceWhenLabel, PaymentTerms, paymentTermsErrors, paymentTermsText } from '@/domain/paymentTerms'
import { INCOTERMS } from '@/lib/constants'
import type { PdfLang } from '@/lib/pdf/i18n'
import { NXT_TITLE, PRICE_LIST_DESCRIPTION, PRICE_LIST_NXT, PRICE_LIST_VALID_DAYS } from '@/lib/pdf/priceListText'
import { FamilyTech, TECHNOLOGIES } from '@/domain/technology'
import type { PriceListItem } from '@/lib/priceList'

const LANGS: [PdfLang, string][] = [
  ['es', 'Español'],
  ['pt', 'Português'],
  ['en', 'English'],
]

/**
 * LISTA DE PREÇOS (PDF): famílias e, dentro de cada uma, os itens (medidas); categoria, Incoterm, agente (comissão dentro do preço), condição de
 * pagamento, idioma, colunas e descrição comercial escolhidos antes de gerar. Validade: 10 dias.
 */
export function PriceListButton(p: { items: PriceListItem[]; families: { id: number; name: string; tech: FamilyTech | null }[]; categories: { id: number; name: string }[]; agents: { id: number; name: string }[] }) {
  const [open, setOpen] = useState(false)
  const [fams, setFams] = useState<string[]>(() => p.families.map((f) => f.name))
  // itens desmarcados (SKU); marcar a família de novo traz todos os itens dela
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const itemsOf = useMemo(() => {
    const m = new Map<string, PriceListItem[]>()
    for (const i of p.items) m.set(i.family, [...(m.get(i.family) ?? []), i])
    return m
  }, [p.items])
  const [categoryId, setCategoryId] = useState<number>(p.categories.find((c) => /categoria a/i.test(c.name))?.id ?? p.categories[0]?.id ?? 0)
  const [incoterm, setIncoterm] = useState('FCA')
  const [agentId, setAgentId] = useState<number | null>(null)
  const [lang, setLang] = useState<PdfLang>('es')
  const [cols, setCols] = useState({ thickness: true, box: true, perPallet: true })
  const [descOn, setDescOn] = useState(true)
  const [desc, setDesc] = useState<Record<PdfLang, string>>({ ...PRICE_LIST_DESCRIPTION })
  // PACIFIL NXT: quadro no início e a menção (ou selo) nos grupos das famílias NXT do Catálogo (menção/selo definidos lá)
  const nxtFamilies = p.families.filter((f) => f.tech?.key === 'NXT')
  const [nxtOn, setNxtOn] = useState(true)
  const [nxtFams, setNxtFams] = useState<string[]>(() => nxtFamilies.map((f) => f.name))
  const [nxtText, setNxtText] = useState<Record<PdfLang, string>>({ ...PRICE_LIST_NXT })
  // condição de pagamento (a mesma estrutura da Proforma)
  const [hasTerms, setHasTerms] = useState(false)
  const [advance, setAdvance] = useState('100')
  const [when, setWhen] = useState<BalanceWhen>('BEFORE_SHIPMENT')
  const [days, setDays] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdf, setPdf] = useState<{ blob: Blob; name: string } | null>(null)
  // assistente de IA: texto digitado ou ditado → opções da tela (o usuário confere e gera)
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiReply, setAiReply] = useState<{ ok: boolean; text: string } | null>(null)

  const adv = Number(advance.replace(',', '.'))
  const terms: PaymentTerms | null = hasTerms ? { advancePct: adv, balanceWhen: adv >= 100 ? null : when, days: days.trim() ? Number(days) : null, note: note.trim() || null } : null
  const termErrors = terms ? paymentTermsErrors(terms) : []
  // famílias marcadas que ainda existem na tela (uma família pode virar "incluída" depois de abrir a página)
  const sel = p.families.map((f) => f.name).filter((n) => fams.includes(n))
  const inFams = sel.flatMap((f) => itemsOf.get(f) ?? [])
  const chosen = inFams.filter((i) => !excluded.has(i.sku))
  // só manda a lista de SKUs quando algum item das famílias marcadas foi desmarcado
  const skus = chosen.length < inFams.length ? chosen.map((i) => i.sku) : null
  const toggleFamily = (name: string, on: boolean) => {
    setFams((xs) => (on ? [...xs, name] : xs.filter((x) => x !== name)))
    if (on) setExcluded((ex) => withItems(ex, (itemsOf.get(name) ?? []).map((i) => i.sku), true))
  }

  /** aplica na tela só o que o assistente definiu (o resto fica como está) */
  function applyPreset(pr: PriceListPreset) {
    if (pr.families?.length) {
      const fs = pr.families.filter((f) => p.families.some((x) => x.name === f))
      setFams(fs)
      // medidas: nas famílias com itens escolhidos, desmarca os outros; as demais vão inteiras
      const picked = new Set(pr.skus ?? [])
      const ex = new Set<string>()
      for (const f of fs) {
        const its = itemsOf.get(f) ?? []
        if (its.some((i) => picked.has(i.sku))) for (const i of its) if (!picked.has(i.sku)) ex.add(i.sku)
      }
      setExcluded(ex)
    }
    if (pr.categoryId != null && p.categories.some((c) => c.id === pr.categoryId)) setCategoryId(pr.categoryId)
    if (pr.incoterm) setIncoterm(pr.incoterm)
    if (pr.agentId === null) setAgentId(null)
    else if (pr.agentId != null && p.agents.some((a) => a.id === pr.agentId)) setAgentId(pr.agentId)
    if (pr.lang) setLang(pr.lang)
    if (pr.columns) setCols((c) => ({ thickness: pr.columns?.thickness ?? c.thickness, box: pr.columns?.box ?? c.box, perPallet: pr.columns?.perPallet ?? c.perPallet }))
    if (pr.payment) {
      setHasTerms(true)
      setAdvance(String(pr.payment.advancePct).replace('.', ','))
      if (pr.payment.balanceWhen) setWhen(pr.payment.balanceWhen)
      setDays(pr.payment.days ? String(pr.payment.days) : '')
      setNote(pr.payment.note ?? '')
    }
  }

  async function runAi() {
    if (!aiText.trim()) return
    setAiBusy(true)
    setAiReply(null)
    try {
      const r = await priceListAssistAction(aiText)
      if (!r.ok) return setAiReply({ ok: false, text: r.error })
      applyPreset(r.preset)
      setAiReply({ ok: true, text: r.text })
    } catch {
      setAiReply({ ok: false, text: 'Falha de comunicação com o servidor.' })
    } finally {
      setAiBusy(false)
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/precos-exportacao/lista', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ families: sel, skus, categoryId, incoterm, agentId, lang, paymentTerms: terms, columns: cols, description: descOn ? desc[lang] : null, nxt: nxtOn ? { families: nxtFams.filter((x) => sel.includes(x)), text: nxtText[lang] } : null }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? 'Não foi possível gerar a lista.')
      }
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'lista-precos.pdf'
      setPdf({ blob, name })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível gerar a lista.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="primary" onClick={() => setOpen(true)} title="PDF da lista de preços para o cliente: categoria, Incoterm, agente, condição de pagamento e idioma">
        📄 Lista de preços (PDF)
      </button>
      {open && (
        <div className="overlay-full" style={{ overflow: 'auto' }}>
          <div className="panel" style={{ maxWidth: 860, margin: '24px auto' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>Lista de preços (PDF)</h2>
              <span className="spacer" />
              <button onClick={() => setOpen(false)}>Fechar</button>
            </div>
            <p className="muted" style={{ marginTop: 4 }}>
              Preço por unidade em USD, com o mesmo cálculo da Proforma. Validade: {PRICE_LIST_VALID_DAYS} dias a partir da emissão. A categoria não aparece no PDF.
            </p>
            {error && <div className="alert error">{error}</div>}
            <fieldset className="pricelist-ai">
              <legend>🤖 Assistente — escreva ou dite como quer a lista</legend>
              <textarea
                rows={2}
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void runAi()
                  }
                }}
                maxLength={2000}
                placeholder="Ex.: lista em espanhol FOB para o Paraguai, com o agente, só silo-bolsa de 9 e 10 pés e Hidrosilo de 2 m até 20.000 L; 30% antecipado e saldo contra BL"
                style={{ width: '100%' }}
              />
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <DictationButton value={aiText} onChange={setAiText} disabled={aiBusy} />
                <button className="primary" onClick={() => void runAi()} disabled={aiBusy || !aiText.trim()}>
                  {aiBusy ? 'Interpretando…' : 'Preencher as opções'}
                </button>
                <small className="muted">A IA só preenche as opções abaixo: confira e clique em Gerar PDF.</small>
              </div>
              {aiReply && (
                <div className={`alert ${aiReply.ok ? 'ok' : 'error'}`} style={{ marginTop: 6, marginBottom: 0, whiteSpace: 'pre-line' }}>
                  {aiReply.text}
                </div>
              )}
            </fieldset>
            <div className="form-grid">
              <label className="field">
                Categoria (tabela)
                <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
                  {p.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Incoterm
                <select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
                  {INCOTERMS.map((i) => (
                    <option key={i}>{i}</option>
                  ))}
                </select>
                {incoterm === 'CIF' && <small className="muted">CIF soma o recargo por kg líquido.</small>}
              </label>
              <label className="field">
                Agente (comissão no preço)
                <select value={agentId ?? ''} onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">— sem agente —</option>
                  {p.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Idioma
                <select value={lang} onChange={(e) => setLang(e.target.value as PdfLang)}>
                  {LANGS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <fieldset>
              <legend>Produtos</legend>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                {p.families.map((f) => (
                  <label key={f.id} className="check">
                    <input type="checkbox" checked={fams.includes(f.name)} onChange={(e) => toggleFamily(f.name, e.target.checked)} /> {f.name}
                  </label>
                ))}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    // como ao marcar uma família: só as que entram agora voltam com todos os itens
                    const added = p.families.filter((f) => !fams.includes(f.name)).flatMap((f) => (itemsOf.get(f.name) ?? []).map((i) => i.sku))
                    setExcluded((ex) => withItems(ex, added, true))
                    setFams(p.families.map((f) => f.name))
                  }}
                >
                  Todas
                </button>
                <button type="button" className="small" onClick={() => setFams([])}>
                  Nenhuma
                </button>
              </div>
              {sel.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <small className="muted">Itens de cada família (clique no nome para escolher as medidas; nas famílias com mais de uma marca, escolha as marcas):</small>
                  {p.families
                    .filter((f) => sel.includes(f.name))
                    .map((f) => (
                      <FamilyItems key={f.id} family={f.name} items={itemsOf.get(f.name) ?? []} excluded={excluded} setItems={(skus, on) => setExcluded((ex) => withItems(ex, skus, on))} />
                    ))}
                  <div style={{ marginTop: 6 }}>
                    <strong>{chosen.length}</strong> {chosen.length === 1 ? 'item' : 'itens'} na lista{skus ? ` (de ${inFams.length})` : ''}
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset>
              <legend>Colunas</legend>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <label className="check">
                  <input type="checkbox" checked={cols.thickness} onChange={(e) => setCols({ ...cols, thickness: e.target.checked })} /> Espessura <small className="muted">(nunca nos Hidrosilos)</small>
                </label>
                <label className="check">
                  <input type="checkbox" checked={cols.box} onChange={(e) => setCols({ ...cols, box: e.target.checked })} /> Medidas da caixa
                </label>
                <label className="check">
                  <input type="checkbox" checked={cols.perPallet} onChange={(e) => setCols({ ...cols, perPallet: e.target.checked })} /> Unidades por palete
                </label>
              </div>
              <small className="muted">Produto e preço (destacados), peso líquido e peso bruto (produto + caixa) sempre aparecem.</small>
            </fieldset>

            <fieldset>
              <legend>
                <label className="check">
                  <input type="checkbox" checked={hasTerms} onChange={(e) => setHasTerms(e.target.checked)} /> Condição de pagamento
                </label>
              </legend>
              {hasTerms ? (
                <div className="form-grid">
                  <label className="field">
                    % antecipado
                    <input inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value)} />
                  </label>
                  {adv < 100 && (
                    <label className="field">
                      Saldo
                      <select value={when} onChange={(e) => setWhen(e.target.value as BalanceWhen)}>
                        {BALANCE_WHEN_OPTIONS.map((w) => (
                          <option key={w} value={w}>
                            {balanceWhenLabel(w)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {adv < 100 && when.startsWith('DAYS_') && (
                    <label className="field">
                      Dias
                      <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
                    </label>
                  )}
                  <label className="field" style={{ gridColumn: '1 / -1' }}>
                    Observação (opcional)
                    <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
                  </label>
                  <small className="muted" style={{ gridColumn: '1 / -1' }}>
                    No PDF ({LANGS.find(([k]) => k === lang)?.[1]}): {termErrors.length ? <span style={{ color: 'var(--crit)' }}>{termErrors.join(' ')}</span> : <strong>{paymentTermsText(terms, lang)}</strong>}
                  </small>
                </div>
              ) : (
                <small className="muted">Sem condição definida: o PDF diz para consultar o Departamento de Exportação.</small>
              )}
            </fieldset>

            <fieldset>
              <legend>
                <label className="check">
                  <input type="checkbox" checked={descOn} onChange={(e) => setDescOn(e.target.checked)} /> Descrição comercial (a mesma para todos os produtos)
                </label>
              </legend>
              {descOn && (
                <>
                  <textarea rows={2} value={desc[lang]} onChange={(e) => setDesc({ ...desc, [lang]: e.target.value })} maxLength={600} style={{ width: '100%' }} />
                  <small className="muted">No idioma escolhido acima. {'{marca}'} vira a marca dos produtos (Pacifil, Agromai…).</small>
                </>
              )}
            </fieldset>

            <fieldset>
              <legend>
                <label className="check">
                  <input type="checkbox" checked={nxtOn} onChange={(e) => setNxtOn(e.target.checked)} /> {NXT_TITLE}
                </label>
              </legend>
              {nxtOn && (
                <>
                  {nxtFamilies.some((f) => sel.includes(f.name)) ? (
                    <>
                      <small className="muted">Quadro destacado no início da lista e a menção nos grupos destas famílias (selo ou só texto, como no Catálogo):</small>
                      <div className="row" style={{ gap: 12, flexWrap: 'wrap', margin: '4px 0 6px' }}>
                        {nxtFamilies
                          .filter((f) => sel.includes(f.name))
                          .map((f) => (
                            <label key={f.id} className="check" style={{ alignItems: 'center' }}>
                              <input type="checkbox" checked={nxtFams.includes(f.name)} onChange={(e) => setNxtFams((xs) => (e.target.checked ? [...xs, f.name] : xs.filter((x) => x !== f.name)))} /> {f.name}
                              {f.tech?.display === 'SEAL' && (
                                // eslint-disable-next-line @next/next/no-img-element -- selo estático pequeno
                                <img src={TECHNOLOGIES.NXT.seal} alt="selo" title="Com selo" width={18} height={18} style={{ marginLeft: 4, verticalAlign: 'middle' }} />
                              )}
                            </label>
                          ))}
                      </div>
                    </>
                  ) : (
                    <small className="muted" style={{ display: 'block', margin: '2px 0 6px' }}>
                      Nenhuma família PACIFIL NXT nesta lista. As famílias NXT (menção ou selo) são definidas no Catálogo: Editar família → Tecnologia.
                    </small>
                  )}
                  <textarea rows={3} value={nxtText[lang]} onChange={(e) => setNxtText({ ...nxtText, [lang]: e.target.value })} maxLength={800} style={{ width: '100%' }} />
                  <small className="muted">Texto no idioma escolhido acima.</small>
                </>
              )}
            </fieldset>

            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="primary" onClick={() => void generate()} disabled={busy || !chosen.length || !categoryId || termErrors.length > 0}>
                {busy ? 'Gerando…' : 'Gerar PDF'}
              </button>
              <button onClick={() => setOpen(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
      {pdf && (
        <PdfPreview
          blob={pdf.blob}
          fileName={pdf.name}
          lang={lang}
          subject={{ es: 'Lista de precios — Pacifil Brasil', pt: 'Lista de preços — Pacifil Brasil', en: 'Price list — Pacifil Brasil' }[lang]}
          docLabel={{ es: 'la lista de precios', pt: 'a lista de preços', en: 'the price list' }[lang]}
          onClose={() => setPdf(null)}
        />
      )}
    </>
  )
}

/** marca (on) ou desmarca os SKUs no conjunto de itens desmarcados */
function withItems(excluded: Set<string>, skus: string[], on: boolean): Set<string> {
  const n = new Set(excluded)
  for (const s of skus) {
    if (on) n.delete(s)
    else n.add(s)
  }
  return n
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** marcas dos itens (Pacifil primeiro, depois alfabética) com a quantidade de itens de cada uma */
function brandsOf(items: PriceListItem[]): [string, number][] {
  const m = new Map<string, number>()
  for (const i of items) m.set(i.brand, (m.get(i.brand) ?? 0) + 1)
  return [...m].sort(([a], [b]) => (a === 'Pacifil' ? -1 : b === 'Pacifil' ? 1 : a.localeCompare(b, 'pt-BR')))
}

/**
 * itens (medidas) de uma família, separados por largura / diâmetro, com busca nas famílias grandes.
 * MARCAS: quando a família tem mais de uma marca no catálogo, escolhe quais entram (sempre visível, mesmo com
 * a lista de itens fechada); marcar/desmarcar uma marca marca/desmarca todos os itens dela.
 */
function FamilyItems({ family, items, excluded, setItems }: { family: string; items: PriceListItem[]; excluded: Set<string>; setItems: (skus: string[], on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const n = items.filter((i) => !excluded.has(i.sku)).length
  const brands = brandsOf(items)
  const multiBrand = brands.length > 1
  const query = fold(q.trim())
  const shown = query ? items.filter((i) => fold(`${i.sku} ${i.name} ${i.brand}`).includes(query)) : items
  const subs = [...new Set(shown.map((i) => i.sub))]
  const all = (xs: PriceListItem[]) => xs.map((i) => i.sku)
  return (
    <div style={{ marginTop: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ padding: 0, background: 'none', border: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left' }}>
          {open ? '▾' : '▸'} <strong>{family}</strong>{' '}
          <span className={n === 0 ? undefined : 'muted'} style={n === 0 ? { color: 'var(--crit)' } : undefined}>
            — {!items.length ? 'sem itens no catálogo' : n === items.length ? (items.length === 1 ? '1 item' : `todos os ${items.length} itens`) : n === 0 ? 'nenhum item (fica fora da lista)' : `${n} de ${items.length} itens`}
          </span>
        </button>
        {items.length > 0 && !multiBrand && <small className="muted">· marca {brands[0][0]}</small>}
      </div>
      {multiBrand && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '2px 0 0 18px' }}>
          <small className="muted">Marcas:</small>
          {brands.map(([b, count]) => {
            const its = items.filter((i) => i.brand === b)
            const on = its.filter((i) => !excluded.has(i.sku)).length
            return (
              <label key={b} className="check" title={on && on < its.length ? `${on} de ${its.length} itens desta marca` : undefined}>
                <input
                  type="checkbox"
                  aria-label={`${family}: marca ${b}`}
                  checked={on === its.length}
                  ref={(el) => {
                    // parcial: alguns itens da marca desmarcados um a um
                    if (el) el.indeterminate = on > 0 && on < its.length
                  }}
                  // parcial ou desmarcada → entra a marca inteira; inteira → sai
                  onChange={() => setItems(all(its), on < its.length)}
                />{' '}
                {b} <small className="muted">({on > 0 && on < its.length ? `${on}/${count}` : count})</small>
              </label>
            )
          })}
        </div>
      )}
      {open && items.length > 0 && (
        <div style={{ padding: '6px 0 4px 18px' }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            {items.length > 12 && <input placeholder={multiBrand ? 'Buscar medida, código ou marca…' : 'Buscar medida ou código…'} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />}
            <button type="button" className="small" onClick={() => setItems(all(shown), true)}>
              {query ? 'Marcar os encontrados' : 'Marcar todos'}
            </button>
            <button type="button" className="small" onClick={() => setItems(all(shown), false)}>
              {query ? 'Desmarcar os encontrados' : 'Desmarcar todos'}
            </button>
          </div>
          {!shown.length && <small className="muted">Nenhum item com “{q.trim()}”.</small>}
          {subs.map((sub) => {
            const xs = shown.filter((i) => i.sub === sub)
            return (
              <div key={sub} style={{ marginBottom: 6 }}>
                {subs.length > 1 && (
                  <div className="row" style={{ gap: 6, alignItems: 'center', margin: '4px 0 2px' }}>
                    <small>
                      <strong>{sub || 'Outros'}</strong>
                    </small>
                    <button type="button" className="small" onClick={() => setItems(all(xs), true)}>
                      todos
                    </button>
                    <button type="button" className="small" onClick={() => setItems(all(xs), false)}>
                      nenhum
                    </button>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '2px 12px' }}>
                  {xs.map((i) => (
                    <label key={i.sku} className="check">
                      <input type="checkbox" checked={!excluded.has(i.sku)} onChange={(e) => setItems([i.sku], e.target.checked)} />
                      <span>
                        {i.name} <small className="muted">{i.sku}</small>
                        {multiBrand && (
                          <small className="badge DRAFT" style={{ marginLeft: 4 }}>
                            {i.brand}
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
