'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { CONFIRM_WORD, type LoadCounts } from '@/lib/maintenance/backupFormat'
import { deleteAllLoadsAction } from './actions'
import { fmtBytes } from './labels'
import css from './manutencao.module.css'

const n = (v: number) => v.toLocaleString('pt-BR')

/** resumo do que foi (ou será) excluído */
function describe(c: LoadCounts) {
  return `${n(c.shipments)} pedido(s), ${n(c.loadPlans)} carga(s), ${n(c.loadPlanVersions)} versão(ões), ${n(c.photos)} foto(s), ${n(c.priceQuotes)} proforma(s)/cotação(ões), ${n(c.exportOperations)} exportação(ões) em curso e ${n(c.aiConversations)} conversa(s) do assistente`
}

/**
 * Cartão "Excluir todas as cargas e proformas" (perigo): 1) baixar o backup (.json.gz); 2) digitar EXCLUIR,
 * confirmar que guardou o backup e excluir. O servidor confere o backup (mesmo usuário, até 60 min, nada
 * alterado depois) antes de apagar.
 */
export function DeleteLoadsCard({ counts }: { counts: LoadCounts }) {
  const router = useRouter()
  const [backup, setBackup] = useState<{ sha256: string; bytes: number; fileName: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<LoadCounts | null>(null)

  const empty = counts.shipments + counts.loadPlans + counts.loadPlanVersions + counts.priceQuotes + counts.aiConversations + counts.exportOperations === 0

  async function downloadBackup() {
    setDownloading(true)
    setError(null)
    try {
      const res = await fetch('/admin/manutencao/backup', { method: 'POST' })
      if (!res.ok) {
        const r = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(r?.error ?? `Falha ao gerar o backup (${res.status}).`)
      }
      const sha256 = res.headers.get('X-Backup-Sha256') ?? ''
      const fileName = res.headers.get('X-Backup-File') ?? 'backup-cargas.json.gz'
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
      setDownloading(false)
    }
  }

  async function remove() {
    if (!backup) return
    setDeleting(true)
    setError(null)
    const r = await deleteAllLoadsAction({ confirm, backupSha256: backup.sha256, savedBackup: saved }).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setDeleting(false)
    if (!r.ok) return setError(r.error)
    setDone(r.counts)
    setBackup(null)
    setConfirm('')
    setSaved(false)
    router.refresh()
  }

  const ready = Boolean(backup) && confirm.trim() === CONFIRM_WORD && saved && !deleting
  return (
    <section className={`panel ${css.card} ${css.danger}`}>
      <h2>Excluir todas as cargas e proformas</h2>
      <div className={css.counts}>
        <Kpi k="Pedidos" v={n(counts.shipments)} />
        <Kpi k="Cargas" v={n(counts.loadPlans)} />
        <Kpi k="Versões" v={n(counts.loadPlanVersions)} s={`${n(counts.approvedVersions)} aprovada(s) · ${n(counts.draftVersions)} rascunho(s)`} />
        <Kpi k="Fotos" v={n(counts.photos)} />
        <Kpi k="Proformas/cotações emitidas" v={n(counts.priceQuotes)} />
        <Kpi k="Exportações em curso" v={n(counts.exportOperations)} />
        <Kpi k="Conversas do assistente" v={n(counts.aiConversations)} />
      </div>
      <p className={css.keep}>O que fica: clientes, agentes, usuários, preços, catálogo, montagens de palete, transportadoras, veículos e configurações.</p>
      {done && <div className="alert ok">Excluídos: {describe(done)}.</div>}
      {error && <div className="alert error">{error}</div>}

      <div className={css.step}>
        <h3>1. Backup</h3>
        <p className="muted">Arquivo com tudo o que será excluído (sem as imagens das fotos). Guarde-o antes de continuar: vale para excluir por 60 minutos.</p>
        <div className={css.actions}>
          <button onClick={downloadBackup} disabled={downloading || deleting || empty}>
            {downloading ? 'Gerando o backup…' : 'Baixar backup (.json.gz)'}
          </button>
        </div>
        {backup && (
          <div className={css.done}>
            Backup baixado: {fmtBytes(backup.bytes)} · <span title={backup.sha256}>{backup.sha256.slice(0, 8)}</span>
          </div>
        )}
        {empty && !done && <small className="muted">Não há cargas nem proformas para excluir.</small>}
      </div>

      <div className={css.step}>
        <h3>2. Confirmar</h3>
        <label className="field">
          Digite {CONFIRM_WORD} para confirmar
          <input className={css.confirmInput} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={!backup || deleting} autoComplete="off" spellCheck={false} />
        </label>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!backup || deleting} /> Baixei e guardei o backup
        </label>
        <div className={css.actions}>
          <button className={css.deleteBtn} onClick={remove} disabled={!ready}>
            {deleting ? 'Excluindo…' : 'Excluir tudo'}
          </button>
        </div>
      </div>
    </section>
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
