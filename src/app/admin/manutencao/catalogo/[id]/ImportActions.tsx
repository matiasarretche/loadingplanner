'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { dt } from '@/components/format'
import type { ApplyResult, CatalogImportStatus, SyncReport } from '@/domain/catalogImport/types'
import css from '../../manutencao.module.css'
import { applyCatalogImportAction, discardCatalogImportAction, simulateCatalogImportAction, syncCatalogImportAction } from './actions'

const n = (v: number) => v.toLocaleString('pt-BR')
const secs = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`

function ResultList({ r }: { r: ApplyResult }) {
  return (
    <ul>
      <li>
        {n(r.variantsCreated)} produto(s) criado(s){r.variantsUpdated ? `, ${n(r.variantsUpdated)} atualizado(s)` : ''}
      </li>
      <li>
        Embalagens: {n(r.packagingCreated)} nova(s){r.packagingNewVersions ? `, ${n(r.packagingNewVersions)} alterada(s)` : ''}
        {r.packagingUnchanged ? `, ${n(r.packagingUnchanged)} sem mudança` : ''} · {n(r.pendingWithoutPackaging)} produto(s) sem caixa (pendentes)
      </li>
      <li>{n(r.deactivated)} produto(s) atual(is) desativado(s)</li>
      {r.familiesCreated.length > 0 && <li>Famílias criadas: {r.familiesCreated.join(', ')}</li>}
      {r.linesCreated.length > 0 && <li>Linhas criadas: {r.linesCreated.join(', ')}</li>}
      {r.reactivated.length > 0 && <li>Reativados: {r.reactivated.join(', ')}</li>}
      <li className="muted">Duração: {secs(r.durationMs)}</li>
    </ul>
  )
}

/**
 * Ações da prévia: simular (transação desfeita), aplicar (com confirmação), descartar e baixar os pendentes;
 * depois de aplicada, acompanha a atualização das montagens de palete (com "Atualizar de novo" se falhar).
 */
export function ImportActions(p: {
  id: number
  status: CatalogImportStatus
  blocked: boolean
  toCreate: number
  toUpdate: number
  pending: number
  deactivations: number
  applied: { at: string; by: string } | null
  result: ApplyResult | null
  syncReport: SyncReport | null
  syncedAt: string | null
  /** atualização das montagens presa (SYNCING há mais de 6 min: a função foi encerrada no meio) */
  syncStale: boolean
  error: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | 'simulate' | 'apply' | 'discard' | 'sync'>(null)
  const [error, setError] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<ApplyResult | null>(null)

  // montagens atualizando em segundo plano: recarrega os dados da página até terminar (no máx. ~6 min)
  const waiting = (p.status === 'SYNCING' && !p.syncStale) || p.status === 'APPLIED'
  useEffect(() => {
    if (!waiting) return
    let ticks = 0
    const t = setInterval(() => {
      if (++ticks > 120) return clearInterval(t)
      router.refresh()
    }, 3000)
    return () => clearInterval(t)
  }, [waiting, router])

  async function simulate() {
    setBusy('simulate')
    setError(null)
    const r = await simulateCatalogImportAction(p.id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(null)
    if (!r.ok) return setError(r.error)
    setSimulation(r.result)
  }

  async function apply() {
    const parts = [`Serão criados ${n(p.toCreate)} produtos (${n(p.pending)} sem caixa, ficam pendentes)`]
    if (p.toUpdate) parts.push(`${n(p.toUpdate)} atualizados`)
    if (!window.confirm(`Aplicar a importação? ${parts.join(', ')} e ${n(p.deactivations)} produtos atuais serão desativados. As cargas salvas não mudam.`)) return
    setBusy('apply')
    setError(null)
    const r = await applyCatalogImportAction(p.id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor. Recarregue a página para ver se a importação foi aplicada.' }))
    setBusy(null)
    if (!r.ok) return setError(r.error)
    setSimulation(null)
    router.refresh()
  }

  async function discard() {
    if (!window.confirm('Descartar esta prévia? O catálogo não muda; ela fica no histórico como descartada.')) return
    setBusy('discard')
    setError(null)
    const r = await discardCatalogImportAction(p.id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(null)
    if (!r.ok) return setError(r.error)
    router.refresh()
  }

  async function sync() {
    setBusy('sync')
    setError(null)
    const r = await syncCatalogImportAction(p.id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(null)
    if (!r.ok) setError(r.error)
    else if (!r.report) setError('A atualização das montagens já está em andamento (ou a importação não está aplicada).')
    router.refresh()
  }

  const isPreview = p.status === 'PREVIEW'
  const appliedStates: CatalogImportStatus[] = ['APPLIED', 'SYNCING', 'SYNCED', 'SYNC_FAILED']
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      {isPreview && (
        <div className={css.actions}>
          <button onClick={simulate} disabled={busy !== null}>
            {busy === 'simulate' ? 'Simulando…' : 'Simular aplicação (sem gravar)'}
          </button>
          <button className="primary" onClick={apply} disabled={busy !== null || p.blocked} title={p.blocked ? 'A prévia tem bloqueios (veja acima)' : undefined}>
            {busy === 'apply' ? 'Aplicando…' : 'Aplicar importação'}
          </button>
          <button className="danger" onClick={discard} disabled={busy !== null}>
            Descartar prévia
          </button>
          <a className="btn" href={`/admin/manutencao/catalogo/${p.id}/pendentes`}>
            Baixar pendentes (.xlsx)
          </a>
        </div>
      )}
      {!isPreview && !appliedStates.includes(p.status) && (
        <div className={css.actions}>
          <span className="muted">{p.status === 'DISCARDED' ? 'Prévia descartada: nada foi gravado no catálogo.' : 'Prévia substituída por uma mais nova: nada foi gravado no catálogo.'}</span>
          <a className="btn" href={`/admin/manutencao/catalogo/${p.id}/pendentes`}>
            Baixar pendentes (.xlsx)
          </a>
        </div>
      )}
      {error && (
        <div className="alert error" style={{ marginTop: 10, marginBottom: 0 }}>
          {error}
        </div>
      )}
      {simulation && (
        <div className={`alert ok ${css.result}`} style={{ marginTop: 10, marginBottom: 0 }}>
          <strong>Simulação (nada foi gravado):</strong>
          <ResultList r={simulation} />
        </div>
      )}
      {appliedStates.includes(p.status) && (
        <div className={css.result}>
          <div>
            <strong>
              Importação aplicada em {dt(p.applied?.at)} por {p.applied?.by ?? '—'}.
            </strong>
          </div>
          {p.result && <ResultList r={p.result} />}
          <div style={{ marginTop: 8 }}>
            Montagens de palete:{' '}
            {p.status === 'SYNCING' && !p.syncStale ? (
              <span className="badge WARNING">atualizando…</span>
            ) : p.status === 'APPLIED' ? (
              <>
                <span className="badge WARNING">aguardando…</span>{' '}
                <button className="small" onClick={sync} disabled={busy !== null}>
                  {busy === 'sync' ? 'Atualizando…' : 'Atualizar agora'}
                </button>
              </>
            ) : p.status === 'SYNCED' && p.syncReport ? (
              <span className="badge ok">
                concluído (criadas {n(p.syncReport.created)}, arquivadas {n(p.syncReport.archived)}, recalculadas {n(p.syncReport.regenerated)}, atualizadas {n(p.syncReport.updated)}
                {p.syncReport.review ? `, ${n(p.syncReport.review)} para revisar` : ''})
              </span>
            ) : (
              <>
                <span className="badge CRITICAL">{p.status === 'SYNCING' ? 'interrompida' : 'falhou'}</span>{' '}
                <button className="small" onClick={sync} disabled={busy !== null}>
                  {busy === 'sync' ? 'Atualizando…' : 'Atualizar de novo'}
                </button>
              </>
            )}
            {p.syncedAt && p.status !== 'SYNCING' && <small className="muted"> · {dt(p.syncedAt)}</small>}
          </div>
          {p.status === 'SYNC_FAILED' && p.error && <div className="alert error" style={{ marginTop: 8, marginBottom: 0 }}>{p.error}</div>}
          {p.syncReport && p.syncReport.lines.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>Relatório das montagens ({n(p.syncReport.lines.length)} linha(s))</summary>
              <div className={css.log}>{p.syncReport.lines.join('\n')}</div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
