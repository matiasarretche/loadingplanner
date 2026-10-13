'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { dt } from '@/components/format'
import type { CatalogImportStatus } from '@/domain/catalogImport/types'
import { IMPORT_STATUS } from './labels'
import css from './manutencao.module.css'

export interface RecentImport {
  id: number
  status: CatalogImportStatus
  createdAt: string
  user: string
  productsFile: string
  planned: number | null
  pending: number | null
}

/** Cartão "Catálogo oficial (planilhas)": envia as duas planilhas e abre a prévia gerada. */
export function CatalogUploadCard({ recent }: { recent: RecentImport[] }) {
  const router = useRouter()
  const [produtos, setProdutos] = useState<File | null>(null)
  const [caixas, setCaixas] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = (produtos?.size ?? 0) + (caixas?.size ?? 0)
  const tooBig = total > BODY_LIMITS.catalogImport
  const notXlsx = [produtos, caixas].some((f) => f && !/\.xlsx$/i.test(f.name))

  async function send() {
    if (!produtos || !caixas) return setError('Escolha as duas planilhas.')
    if (notXlsx) return setError('As duas planilhas precisam ser .xlsx (no Excel: Salvar como › Pasta de Trabalho do Excel).')
    if (tooBig) return setError(`Planilhas grandes demais (${fmtMB(total, true)}; máx. ${fmtMB(BODY_LIMITS.catalogImport)}). Dica: apague as linhas vazias abaixo dos dados e salve de novo.`)
    setBusy(true)
    setError(null)
    const fd = new FormData()
    fd.append('produtos', produtos)
    fd.append('caixas', caixas)
    try {
      const res = await fetch('/admin/manutencao/catalogo/importar', { method: 'POST', body: fd })
      const r = (await res.json().catch(() => null)) as { ok: true; id: number } | { ok: false; error: string } | null
      if (!r) throw new Error(res.status === 413 ? 'Planilhas grandes demais para enviar.' : `Resposta inesperada do servidor (${res.status}).`)
      if (!r.ok) throw new Error(r.error)
      router.push(`/admin/manutencao/catalogo/${r.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha de comunicação com o servidor.')
      setBusy(false)
    }
  }

  return (
    <section className={`panel ${css.card}`}>
      <h2>Catálogo oficial (planilhas)</h2>
      <p className="muted">Envie a planilha de PRODUTOS e a TABELA DAS CAIXAS. Nada é gravado no catálogo até você conferir a prévia e clicar em Aplicar.</p>
      <div className={css.fields}>
        <label className="field">
          Planilha de produtos (.xlsx)
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => setProdutos(e.target.files?.[0] ?? null)} />
        </label>
        <label className="field">
          Tabela de caixas (.xlsx)
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => setCaixas(e.target.files?.[0] ?? null)} />
        </label>
        {total > 0 && <small className={tooBig ? 'field-error' : 'muted'}>Total: {fmtMB(total, true)} (máx. {fmtMB(BODY_LIMITS.catalogImport)})</small>}
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className={css.actions}>
        <button className="primary" onClick={send} disabled={busy || !produtos || !caixas || tooBig}>
          Gerar prévia
        </button>
        {busy && <span className={css.busy}>Lendo as planilhas… (pode levar até 1 minuto)</span>}
      </div>

      <h3>Importações recentes</h3>
      {recent.length === 0 ? (
        <p className="muted">Nenhuma importação ainda.</p>
      ) : (
        <div className={css.tableWrap}>
          <table className="data compact">
            <thead>
              <tr>
                <th>Data</th>
                <th>Usuário</th>
                <th>Situação</th>
                <th className="num">Produtos</th>
                <th className="num">Pendentes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className={css.mono}>
                    {dt(r.createdAt)}
                    <br />
                    <small>#{r.id}</small>
                  </td>
                  <td>{r.user}</td>
                  <td>
                    <span className={`badge ${IMPORT_STATUS[r.status]?.badge ?? 'INFO'}`}>{IMPORT_STATUS[r.status]?.label ?? r.status}</span>
                  </td>
                  <td className="num">{r.planned ?? '—'}</td>
                  <td className="num">{r.pending ?? '—'}</td>
                  <td>
                    <Link href={`/admin/manutencao/catalogo/${r.id}`}>{r.status === 'PREVIEW' ? 'Abrir prévia' : 'Ver'}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
