'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import {
  confirmWordOf,
  type CustomerChange,
  CUSTOMER_SHEET_COLUMNS,
  type CustomerCounts,
  type CustomerImportMode,
  type CustomerImportPlan,
  FIELD_LABEL,
  leadingZeroMessage,
  nameKey,
  rowsLabel,
  type SheetIssue,
} from '@/domain/customerImport'
import type { CustomerApplyResult, CustomerImportPreview } from '@/lib/maintenance/customerImport'
import { fmtBytes } from './labels'
import css from './manutencao.module.css'

const n = (v: number) => v.toLocaleString('pt-BR')
const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** resumo do que foi (ou seria) feito */
function describe(r: CustomerApplyResult) {
  if (r.mode === 'replace') return `${n(r.deleted)} cliente(s) apagado(s) e ${n(r.inserted)} criado(s) pela planilha`
  return `${n(r.inserted)} cliente(s) novo(s), ${n(r.updated)} atualizado(s), ${n(r.unchanged)} sem mudança e ${n(r.untouched)} não tocado(s)`
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
 * Cartão "Clientes de exportação (planilha)": 1) escolher o modo e a planilha → PRÉVIA (nada é gravado);
 * 2) baixar o backup dos clientes atuais; 3) digitar a palavra, confirmar que guardou o backup e aplicar
 * (ou só simular). O servidor confere o mesmo arquivo (sha256), o backup e, ao substituir, que não há
 * nenhum pedido no sistema.
 */
export function CustomerImportCard({ current, shipments }: { current: CustomerCounts; shipments: number }) {
  const router = useRouter()
  const [mode, setMode] = useState<CustomerImportMode>('replace')
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [preview, setPreview] = useState<CustomerImportPreview | null>(null)
  const [backup, setBackup] = useState<{ sha256: string; bytes: number; fileName: string } | null>(null)
  const [confirm, setConfirm] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState<null | 'preview' | 'backup' | 'simulate' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<CustomerApplyResult | null>(null)
  const [done, setDone] = useState<CustomerApplyResult | null>(null)

  const word = confirmWordOf(mode)
  const tooBig = (file?.size ?? 0) > BODY_LIMITS.customerImport
  const plan = preview?.plan
  const blockedByShipments = mode === 'replace' && (preview?.shipments ?? 0) > 0
  const nothingToDo = mode === 'update' && plan != null && plan.update.toInsert + plan.update.toUpdate === 0
  // código da planilha que só difere de um do sistema nos zeros à esquerda: atualizar duplicaria o cliente
  const blockedByZeros = mode === 'update' && (plan?.update.leadingZeroCodes.length ?? 0) > 0
  const blocked = !preview || preview.errors.length > 0 || preview.customers.length === 0 || blockedByShipments || blockedByZeros || nothingToDo

  function chooseFile(f: File | null) {
    setFile(f)
    setPreview(null)
    setSimulation(null)
    setError(null)
  }

  function chooseMode(m: CustomerImportMode) {
    setMode(m)
    setConfirm('')
    setSimulation(null)
  }

  async function makePreview() {
    if (!file) return setError('Escolha a planilha (.xlsx).')
    if (!/\.xlsx$/i.test(file.name)) return setError('A planilha precisa ser .xlsx (no Excel: Salvar como › Pasta de Trabalho do Excel).')
    if (tooBig) return setError(`Planilha grande demais (${fmtMB(file.size, true)}; máx. ${fmtMB(BODY_LIMITS.customerImport)}).`)
    setBusy('preview')
    setError(null)
    setSimulation(null)
    setDone(null)
    const fd = new FormData()
    fd.append('arquivo', file)
    try {
      const r = await post<{ preview: CustomerImportPreview }>('/admin/manutencao/clientes/previa', fd)
      setPreview(r.preview)
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : 'Falha de comunicação com o servidor.')
    } finally {
      setBusy(null)
    }
  }

  async function downloadBackup() {
    setBusy('backup')
    setError(null)
    try {
      const res = await fetch('/admin/manutencao/clientes/backup', { method: 'POST' })
      if (!res.ok) {
        const r = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(r?.error ?? `Falha ao gerar o backup (${res.status}).`)
      }
      const sha256 = res.headers.get('X-Backup-Sha256') ?? ''
      const fileName = res.headers.get('X-Backup-File') ?? 'backup-clientes.json.gz'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setBackup({ sha256, bytes: blob.size, fileName })
    } catch (e) {
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
    fd.append('modo', mode)
    fd.append('sha256', preview.file.sha256)
    fd.append('simular', dryRun ? '1' : '0')
    fd.append('confirmacao', confirm)
    fd.append('backupSalvo', saved ? '1' : '0')
    fd.append('backupSha256', backup?.sha256 ?? '')
    try {
      const r = await post<{ result: CustomerApplyResult }>('/admin/manutencao/clientes/aplicar', fd)
      if (dryRun) {
        setSimulation(r.result)
      } else {
        setDone(r.result)
        setPreview(null)
        setFile(null)
        setFileKey((k) => k + 1)
        setBackup(null)
        setConfirm('')
        setSaved(false)
        router.refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : dryRun ? 'Falha de comunicação com o servidor.' : 'Falha de comunicação com o servidor. Recarregue a página para ver se os clientes mudaram.')
    } finally {
      setBusy(null)
    }
  }

  const ready = !blocked && Boolean(backup) && confirm.trim() === word && saved && busy === null
  return (
    <section className={`panel ${css.card} ${css.danger} ${css.full}`}>
      <h2>Clientes de exportação (planilha)</h2>
      <div className={css.counts}>
        <Kpi k="Clientes atuais" v={n(current.customers)} s={`${n(current.inactive)} inativo(s)`} />
        <Kpi k="Com código do ERP" v={n(current.withCode)} />
        <Kpi k="Com agente vinculado" v={n(current.withAgent)} />
        <Kpi k="Pedidos no sistema" v={n(shipments)} s={shipments ? 'bloqueiam “substituir todos”' : undefined} />
      </div>
      <p className={css.keep}>
        Primeira aba, linha 1 com o cabeçalho exato: <span className={css.small}>{CUSTOMER_SHEET_COLUMNS.map((c) => c.header).join(' | ')}</span>. Agentes, preços, catálogo e configurações não mudam.
      </p>
      {done && <div className="alert ok">Clientes atualizados: {describe(done)}.</div>}
      {error && <div className="alert error">{error}</div>}

      <div className={css.step}>
        <h3>1. Planilha</h3>
        <div className={css.fields}>
          <label className="check">
            <input type="radio" name="customer-import-mode" checked={mode === 'replace'} onChange={() => chooseMode('replace')} disabled={busy !== null} /> Substituir todos os clientes (apaga os atuais; exige que não haja nenhuma carga)
          </label>
          <label className="check">
            <input type="radio" name="customer-import-mode" checked={mode === 'update'} onChange={() => chooseMode('update')} disabled={busy !== null} /> Atualizar pelo código (sem apagar clientes): cria os códigos novos e grava nos existentes só os campos que mudam (Observações vazias na planilha mantêm as do sistema)
          </label>
          <label className="field">
            Planilha dos clientes (.xlsx)
            <input key={fileKey} type="file" accept={XLSX_ACCEPT} disabled={busy !== null} onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <small className={tooBig ? 'field-error' : 'muted'}>{fmtMB(file.size, true)} (máx. {fmtMB(BODY_LIMITS.customerImport)})</small>}
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
            <Kpi k="Clientes na planilha" v={n(preview.customers.length)} s={preview.errors.length ? `${n(preview.errors.length)} erro(s)` : undefined} />
            {mode === 'replace' ? (
              <>
                <Kpi k="Clientes atuais apagados" v={n(plan.replace.toDelete)} s={plan.replace.inactiveDeleted ? `${n(plan.replace.inactiveDeleted)} inativo(s)` : undefined} />
                <Kpi k="Clientes criados" v={n(plan.replace.toInsert)} />
              </>
            ) : (
              <>
                <Kpi k="Novos (código novo)" v={n(plan.update.toInsert)} />
                <Kpi k="Atualizados" v={n(plan.update.toUpdate)} />
                <Kpi k="Sem mudança" v={n(plan.update.unchanged)} />
                <Kpi k="Não tocados" v={n(plan.update.withoutCode + plan.update.notInSheet)} s={`${n(plan.update.withoutCode)} sem código · ${n(plan.update.notInSheet)} fora da planilha`} />
              </>
            )}
          </div>
          {blockedByShipments && (
            <div className="alert error">
              Há {n(preview.shipments)} pedido(s) no sistema ligados aos clientes atuais. Exclua antes todas as cargas (botão acima).
            </div>
          )}
          {blockedByZeros && <div className="alert error">{leadingZeroMessage(plan.update.leadingZeroCodes)}</div>}
          {nothingToDo && <div className="alert ok">Nada a atualizar: todos os códigos da planilha já estão iguais no sistema.</div>}
          <Issues list={preview.errors} level="BLOCKER" />
          <Issues list={[...planWarnings(mode, plan), ...preview.warnings]} level="WARN" />

          {mode === 'update' && plan.update.changes.length > 0 && (
            <details>
              <summary>Ver os {n(plan.update.changes.length)} cliente(s) que serão atualizados</summary>
              <div className={css.tableWrap}>
                <table className="data compact">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>Código</th>
                      <th>Razão social (atual → planilha)</th>
                      <th>Campos alterados (atual → planilha)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.update.changes.map((c) => (
                      <tr key={c.code}>
                        <td className={css.mono}>{c.row}</td>
                        <td className={css.mono}>{c.code}</td>
                        <td>
                          {c.previousName != null ? (
                            <>
                              <del>{c.previousName}</del> → <strong>{c.name}</strong>
                            </>
                          ) : (
                            c.name
                          )}
                        </td>
                        <td className={css.cellNotes}>
                          <ChangedFields change={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {preview.customers.length > 0 && (
            <details>
              <summary>Ver os {n(preview.customers.length)} cliente(s) da planilha</summary>
              <div className={css.tableWrap}>
                <table className={`data compact ${css.wide}`}>
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>Código</th>
                      <th>Razão social</th>
                      <th>Endereço</th>
                      <th>Cidade</th>
                      <th>Estado/Província</th>
                      <th>País</th>
                      <th>ID fiscal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.customers.map((c) => (
                      <tr key={c.code}>
                        <td className={css.mono}>{c.row}</td>
                        <td className={css.mono}>{c.code}</td>
                        <td>{c.name}</td>
                        <td className={css.cellNotes}>{[c.address, c.addressComplement, c.district, c.postalCode].filter(Boolean).join(' · ') || '—'}</td>
                        <td>{c.city ?? '—'}</td>
                        <td>{c.state ?? '—'}</td>
                        <td>{c.country}</td>
                        <td>{c.taxId ?? '—'}</td>
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
        <h3>3. Backup</h3>
        <p className="muted">Arquivo com todos os clientes atuais (todos os campos, com o agente vinculado). Guarde-o antes de continuar: vale por 60 minutos e só enquanto nenhum cliente mudar.</p>
        <div className={css.actions}>
          <button onClick={downloadBackup} disabled={busy !== null}>
            {busy === 'backup' ? 'Gerando o backup…' : 'Baixar backup dos clientes atuais (.json.gz)'}
          </button>
        </div>
        {backup && (
          <div className={css.done}>
            Backup baixado: {fmtBytes(backup.bytes)} · <span title={backup.sha256}>{backup.sha256.slice(0, 8)}</span>
          </div>
        )}
      </div>

      <div className={css.step}>
        <h3>4. Confirmar</h3>
        <label className="field">
          Digite {word} para confirmar
          <input className={css.confirmInput} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={!backup || blocked || busy !== null} autoComplete="off" spellCheck={false} />
        </label>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!backup || blocked || busy !== null} /> Baixei e guardei o backup
        </label>
        <div className={css.actions}>
          <button onClick={() => run(true)} disabled={blocked || busy !== null} title={blocked ? 'Gere uma prévia sem bloqueios' : undefined}>
            {busy === 'simulate' ? 'Simulando…' : 'Simular (sem gravar)'}
          </button>
          <button className={css.deleteBtn} onClick={() => run(false)} disabled={!ready}>
            {busy === 'apply' ? 'Aplicando…' : mode === 'replace' ? 'Substituir todos os clientes' : 'Atualizar pelo código'}
          </button>
        </div>
        {simulation && (
          <div className={`alert ok ${css.result}`}>
            <strong>Simulação (nada foi gravado):</strong> {describe(simulation)}.{' '}
            {simulation.backupChecked ? 'Backup conferido.' : 'Backup não conferido (ainda não baixado).'}
          </div>
        )}
      </div>
    </section>
  )
}

/** avisos do plano (dependem dos clientes atuais e do modo) */
function planWarnings(mode: CustomerImportMode, plan: CustomerImportPlan): SheetIssue[] {
  if (mode === 'replace')
    return plan.replace.agentLinksLost > 0 ? [{ rows: [], message: `${n(plan.replace.agentLinksLost)} cliente(s) atual(is) têm agente vinculado: o vínculo se perde (a planilha não traz agente; fica no backup).` }] : []
  const out: SheetIssue[] = []
  // outra empresa (não só maiúsculas/acentos/pontuação): o código do sistema pode estar errado
  const renamed = plan.update.changes.filter((c) => c.previousName != null && nameKey(c.previousName) !== nameKey(c.name))
  if (renamed.length)
    out.push({
      rows: renamed.map((c) => c.row),
      message: `${n(renamed.length)} cliente(s) do sistema passam a ter OUTRA razão social (ex.: código ${renamed[0].code}: “${renamed[0].previousName}” → “${renamed[0].name}”). Confira se o código é mesmo desse cliente: ele continua com os pedidos e o agente.`,
    })
  const cleared = plan.update.changes.filter((c) => c.cleared.length > 0)
  if (cleared.length) {
    const labels = [...new Set(cleared.flatMap((c) => c.cleared))].map((f) => FIELD_LABEL[f])
    out.push({
      rows: cleared.map((c) => c.row),
      message: `${n(cleared.length)} cliente(s) terão campos APAGADOS (vazios na planilha, preenchidos no sistema): ${labels.join(', ')}. Observações vazias não apagam.`,
    })
  }
  for (const g of plan.update.sameNameWithoutCode)
    out.push({ rows: g.rows, message: `Já existe cliente SEM código com a razão social “${g.name}”: o da planilha entra como cliente novo e o antigo continua.` })
  return out
}

/** texto curto para a tabela (o completo fica no title) */
const clip = (v: string, max = 80) => (v.length > max ? `${v.slice(0, max - 1)}…` : v)

/** campos alterados de um cliente: valor atual → valor da planilha; vazio na planilha = "será apagado" */
function ChangedFields({ change }: { change: CustomerChange }) {
  // a razão social aparece na coluna ao lado
  const fields = change.fields.filter((f) => f !== 'name')
  if (!fields.length) return <>—</>
  return (
    <>
      {fields.map((f) => {
        const d = change.diff[f]
        const de = d?.de ?? null
        const para = d?.para ?? null
        return (
          <div key={f} title={`${de ?? '(vazio)'} → ${para ?? '(vazio)'}`}>
            <strong>{FIELD_LABEL[f]}:</strong>{' '}
            {para == null ? (
              <>
                <del>{clip(de ?? '')}</del> <strong>(será apagado)</strong>
              </>
            ) : (
              <>
                {de == null ? <em>vazio</em> : <del>{clip(de)}</del>} → {clip(para)}
              </>
            )}
          </div>
        )
      })}
    </>
  )
}

function Issues({ list, level }: { list: SheetIssue[]; level: 'BLOCKER' | 'WARN' }) {
  if (!list.length) return null
  return (
    <ul className={css.warnings}>
      {list.map((w, i) => (
        <li key={i} className={level}>
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
