'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { fmtMB } from '@/components/intake/limits'
import {
  CARRIER_IMPORT_MAX_BYTES,
  CARRIER_SHEET_COLUMNS,
  CARRIER_UPDATE_WORD,
  type CarrierCounts,
  carrierPlanWarnings,
  nearCarrierCodeMessage,
  type SheetIssue,
} from '@/domain/carrierImport'
import { rowsLabel } from '@/domain/customerImport'
import type { CarrierApplyResult, CarrierImportPreview } from '@/lib/maintenance/carrierImport'
import { fmtBytes } from './labels'
import css from './manutencao.module.css'

const n = (v: number) => v.toLocaleString('pt-BR')
const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** resumo do que foi (ou seria) feito */
function describe(r: CarrierApplyResult) {
  const kept = r.keptComplete ? ` (${n(r.keptComplete)} com o nome completado no sistema)` : ''
  return `${n(r.inserted)} transportadora(s) nova(s), ${n(r.renamed)} com o nome atualizado, ${n(r.unchanged + r.keptComplete)} sem mudança${kept} e ${n(r.untouched)} fora da planilha (não tocadas)`
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error: string }

/** envia o formulário e lê a resposta JSON da rota ({ ok, … } ou { ok: false, error }) */
async function post<T>(url: string, fd: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: fd })
  const r = (await res.json().catch(() => null)) as Reply<T> | null
  if (!r) throw new Error(res.status === 413 ? 'Planilha grande demais para enviar.' : `Resposta inesperada do servidor (${res.status}).`)
  if (!r.ok) throw new Error(r.error)
  return r
}

/**
 * Cartão "Transportadoras (planilha)": 1) escolher a planilha do ERP → PRÉVIA (nada é gravado); 2) conferir
 * os códigos novos, os nomes que mudam e os avisos (filiais, especiais, nomes cortados); 3) digitar ATUALIZAR e
 * aplicar (ou só simular). Um modo só: atualizar pelo código, sem apagar nada. O servidor confere o mesmo
 * arquivo (sha256) e refaz o plano dentro da transação.
 */
export function CarrierImportCard({ current }: { current: CarrierCounts }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [preview, setPreview] = useState<CarrierImportPreview | null>(null)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState<null | 'preview' | 'simulate' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<CarrierApplyResult | null>(null)
  const [done, setDone] = useState<CarrierApplyResult | null>(null)

  const tooBig = (file?.size ?? 0) > CARRIER_IMPORT_MAX_BYTES
  const plan = preview?.plan
  const blockedByCodes = (plan?.nearCodes.length ?? 0) > 0
  const nothingToDo = plan != null && plan.toInsert + plan.toRename === 0
  const blocked = !preview || preview.errors.length > 0 || preview.carriers.length === 0 || blockedByCodes || nothingToDo
  const ready = !blocked && confirm.trim() === CARRIER_UPDATE_WORD && busy === null

  // marca de cada transportadora nova na tabela (filial / especial)
  const tags = useMemo(() => {
    const m = new Map<string, string[]>()
    if (!preview) return m
    for (const g of preview.sameName) for (const c of g.codes) m.set(c, [`filial (${g.codes.length})`])
    for (const sp of preview.specials) m.set(sp.code, [...(m.get(sp.code) ?? []), sp.label])
    return m
  }, [preview])
  const newCodes = useMemo(() => new Set(plan?.insertCodes ?? []), [plan])

  function chooseFile(f: File | null) {
    setFile(f)
    setPreview(null)
    setSimulation(null)
    setError(null)
  }

  async function makePreview() {
    if (!file) return setError('Escolha a planilha (.xlsx).')
    if (!/\.xlsx$/i.test(file.name)) return setError('A planilha precisa ser .xlsx (no Excel: Salvar como › Pasta de Trabalho do Excel).')
    if (tooBig) return setError(`Planilha grande demais (${fmtMB(file.size, true)}; máx. ${fmtMB(CARRIER_IMPORT_MAX_BYTES)}).`)
    setBusy('preview')
    setError(null)
    setSimulation(null)
    setDone(null)
    setConfirm('')
    const fd = new FormData()
    fd.append('arquivo', file)
    try {
      const r = await post<{ preview: CarrierImportPreview }>('/admin/manutencao/transportadoras/previa', fd)
      setPreview(r.preview)
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : 'Falha de comunicação com o servidor.')
    } finally {
      setBusy(null)
    }
  }

  async function run(dryRun: boolean) {
    if (!file || !preview) return
    setBusy(dryRun ? 'simulate' : 'apply')
    setError(null)
    setSimulation(null)
    const fd = new FormData()
    fd.append('arquivo', file)
    fd.append('sha256', preview.file.sha256)
    fd.append('simular', dryRun ? '1' : '0')
    fd.append('confirmacao', confirm)
    try {
      const r = await post<{ result: CarrierApplyResult }>('/admin/manutencao/transportadoras/aplicar', fd)
      if (dryRun) {
        setSimulation(r.result)
      } else {
        setDone(r.result)
        setPreview(null)
        setFile(null)
        setFileKey((k) => k + 1)
        setConfirm('')
        router.refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : dryRun ? 'Falha de comunicação com o servidor.' : 'Falha de comunicação com o servidor. Recarregue a página para ver se as transportadoras mudaram.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={`panel ${css.card} ${css.full}`}>
      <h2>Transportadoras (planilha)</h2>
      <div className={css.counts}>
        <Kpi k="Transportadoras atuais" v={n(current.total)} s={current.inactive ? `${n(current.inactive)} inativa(s)` : undefined} />
        <Kpi k="Ativas" v={n(current.active)} />
      </div>
      <p className={css.keep}>
        Primeira aba, linha 1 com o cabeçalho: <span className={css.small}>{CARRIER_SHEET_COLUMNS.map((c) => c.header).join(' | ')}</span>. Atualiza pelo código do ERP: cria os códigos novos (ativos) e, nos existentes, grava só o nome quando muda. Nada é apagado; contato,
        telefone, e-mail, observações e “ativa” não mudam. Nomes repetidos com códigos diferentes (filiais) entram todos.
      </p>
      {done && <div className="alert ok">Transportadoras atualizadas: {describe(done)}.</div>}
      {error && <div className="alert error">{error}</div>}

      <div className={css.step}>
        <h3>1. Planilha</h3>
        <div className={css.fields}>
          <label className="field">
            Planilha das transportadoras do ERP (.xlsx)
            <input key={fileKey} type="file" accept={XLSX_ACCEPT} disabled={busy !== null} onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <small className={tooBig ? 'field-error' : 'muted'}>{fmtMB(file.size, true)} (máx. {fmtMB(CARRIER_IMPORT_MAX_BYTES)})</small>}
        </div>
        <div className={css.actions}>
          <button className="primary" onClick={makePreview} disabled={busy !== null || !file || tooBig}>
            {busy === 'preview' ? 'Lendo a planilha…' : 'Gerar prévia'}
          </button>
          <small className="muted">Nada é gravado na prévia.</small>
        </div>
      </div>

      {preview && plan && (
        <div className={css.step}>
          <h3>2. Prévia</h3>
          <div className={css.meta}>
            <span>{preview.file.name}</span>
            <span>{fmtBytes(preview.file.bytes)}</span>
            <span>aba “{preview.file.sheetName}”</span>
            <span title={preview.file.sha256}>{preview.file.sha256.slice(0, 8)}</span>
          </div>
          <div className={css.counts}>
            <Kpi k="Na planilha" v={n(preview.carriers.length)} s={preview.errors.length ? `${n(preview.errors.length)} erro(s)` : undefined} />
            <Kpi k="Novas (código novo)" v={n(plan.toInsert)} />
            <Kpi k="Nomes que mudam" v={n(plan.toRename)} />
            <Kpi k="Sem mudança" v={n(plan.unchanged + plan.keptComplete.length)} s={plan.keptComplete.length ? `${n(plan.keptComplete.length)} com o nome completado no sistema` : undefined} />
            <Kpi k="Fora da planilha" v={n(plan.notInSheet.length)} s="cadastradas, não tocadas" />
          </div>
          {blockedByCodes && <div className="alert error">{nearCarrierCodeMessage(plan.nearCodes)}</div>}
          {nothingToDo && preview.errors.length === 0 && preview.carriers.length > 0 && <div className="alert ok">Nada a atualizar: todos os códigos da planilha já estão cadastrados com o mesmo nome.</div>}
          <Issues list={preview.errors} level="BLOCKER" />
          <Issues list={[...carrierPlanWarnings(plan), ...preview.warnings]} level="WARN" />

          {plan.renames.length > 0 && (
            <details>
              <summary>Ver os {n(plan.renames.length)} nome(s) que mudam</summary>
              <div className={css.tableWrap}>
                <table className="data compact">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>Código</th>
                      <th>Nome (atual → planilha)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.renames.map((r) => (
                      <tr key={r.code}>
                        <td className={css.mono}>{r.row}</td>
                        <td className={css.mono}>{r.code}</td>
                        <td>
                          <del>{r.de}</del> → <strong>{r.para}</strong>
                          {r.otherCompany && <small className="muted"> · outro nome: confira o código</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {plan.insertCodes.length > 0 && (
            <details>
              <summary>Ver as {n(plan.insertCodes.length)} transportadora(s) nova(s)</summary>
              <div className={css.tableWrap}>
                <table className="data compact">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>Código</th>
                      <th>Nome</th>
                      <th>Observação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.carriers
                      .filter((c) => newCodes.has(c.code))
                      .map((c) => (
                        <tr key={c.code}>
                          <td className={css.mono}>{c.row}</td>
                          <td className={css.mono}>{c.code}</td>
                          <td>{c.name}</td>
                          <td className={css.cellNotes}>{[...(tags.get(c.code) ?? []), ...(c.maybeTruncated ? ['nome no limite do ERP'] : [])].join(' · ') || '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {preview.sameName.length > 0 && (
            <details>
              <summary>Ver os {n(preview.sameName.length)} nome(s) com mais de um código (filiais)</summary>
              <div className={css.tableWrap}>
                <table className="data compact">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Códigos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sameName.map((g) => (
                      <tr key={g.codes.join(',')}>
                        <td>{g.name}</td>
                        <td className={css.cellNotes}>
                          {g.codes.length} · {g.codes.join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {plan.notInSheet.length > 0 && (
            <details>
              <summary>Ver as {n(plan.notInSheet.length)} cadastrada(s) fora da planilha (não tocadas)</summary>
              <div className={css.tableWrap}>
                <table className="data compact">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Nome</th>
                      <th>Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.notInSheet.map((c) => (
                      <tr key={c.id}>
                        <td className={css.mono}>{c.code}</td>
                        <td>{c.name}</td>
                        <td>{c.active ? 'Ativa' : 'Inativa'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      <div className={css.step}>
        <h3>3. Confirmar</h3>
        <label className="field">
          Digite {CARRIER_UPDATE_WORD} para confirmar
          <input className={css.confirmInput} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={blocked || busy !== null} autoComplete="off" spellCheck={false} />
        </label>
        <div className={css.actions}>
          <button onClick={() => run(true)} disabled={blocked || busy !== null} title={blocked ? 'Gere uma prévia sem bloqueios' : undefined}>
            {busy === 'simulate' ? 'Simulando…' : 'Simular (sem gravar)'}
          </button>
          <button className="primary" onClick={() => run(false)} disabled={!ready}>
            {busy === 'apply' ? 'Aplicando…' : 'Atualizar pelo código'}
          </button>
        </div>
        {simulation && (
          <div className={`alert ok ${css.result}`}>
            <strong>Simulação (nada foi gravado):</strong> {describe(simulation)}.
          </div>
        )}
      </div>
    </section>
  )
}

function Issues({ list, level }: { list: SheetIssue[]; level: 'BLOCKER' | 'WARN' }) {
  if (!list.length) return null
  return (
    <ul className={css.warnings}>
      {list.map((w, i) => (
        <li key={i} className={css[level]}>
          {level === 'BLOCKER' ? 'Erro: ' : ''}
          {w.message}
          {w.rows.length > 0 && <small>{rowsLabel(w.rows)}</small>}
        </li>
      ))}
    </ul>
  )
}

function Kpi({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}
