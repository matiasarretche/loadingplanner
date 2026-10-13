'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { confirmOrderAction } from '@/app/exportacoes/actions'
import { todayBR } from '@/domain/exportTracking'

/**
 * "Confirmar pedido" na página da carga (Exportações em curso): o cliente confirmou o pedido e a carga
 * passa a ter seguimento. Exige versão APROVADA (o servidor confere de novo). Pede a data da confirmação
 * (padrão: hoje em São Paulo), o recebimento do pagamento (opcional) e, quando há, se confirma junto as
 * outras cargas aprovadas do mesmo pedido que ainda não foram confirmadas.
 */
export function ConfirmOrderButton({ planId, siblings, className = 'small primary' }: { planId: number; siblings: { loadPlanId: number; label: string }[]; className?: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmedAt, setConfirmedAt] = useState('')
  const [paidAt, setPaidAt] = useState('')
  const [all, setAll] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc fecha (exceto durante a gravação)
  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setOpen(false)
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [open, busy])

  function start() {
    setConfirmedAt(todayBR())
    setPaidAt('')
    setAll(true)
    setError(null)
    setOpen(true)
  }

  async function confirm() {
    setBusy(true)
    setError(null)
    const r = await confirmOrderAction(planId, { confirmedAt, paymentReceivedAt: paidAt || null, includeSiblings: siblings.length > 0 && all }).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setOpen(false)
    // a página volta com "Ver seguimento" e a etapa no lugar deste botão
    router.refresh()
  }

  const n = siblings.length
  return (
    <>
      <button className={className} onClick={start} title="O cliente confirmou o pedido: a carga passa para Exportações em curso (seguimento)">
        Confirmar pedido
      </button>
      {open && (
        <div className="overlay-full" style={{ display: 'grid', placeItems: 'center', background: 'rgba(13,43,34,.55)', zIndex: 1000 }} onClick={(e) => e.target === e.currentTarget && !busy && setOpen(false)}>
          <div className="panel" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title" style={{ width: 'min(480px, 94vw)', textAlign: 'left' }}>
            <h3 id="confirm-order-title" style={{ marginTop: 0 }}>
              Confirmar pedido
            </h3>
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
              A carga passa para Exportações em curso. Cliente, produtos, pesos e valores continuam vindo da carga (última versão aprovada).
            </p>
            <div style={{ display: 'grid', gap: 12 }}>
              <label className="field">
                Data da confirmação
                <input type="date" value={confirmedAt} onChange={(e) => setConfirmedAt(e.target.value)} required disabled={busy} />
              </label>
              <label className="field">
                Recebimento do pagamento (opcional)
                <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} disabled={busy} />
                {!paidAt && <small className="muted">Pagamento não informado</small>}
              </label>
              {n > 0 && (
                <div>
                  <label className="check">
                    <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={busy} />
                    Confirmar também {n === 1 ? 'a outra carga aprovada' : `as outras ${n} cargas aprovadas`} deste pedido
                  </label>
                  <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 30, fontSize: 12 }}>
                    {siblings.map((s) => (
                      <li key={s.loadPlanId}>{s.label}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {error && (
              <div className="alert error" style={{ margin: '12px 0 0' }}>
                {error}
              </div>
            )}
            <div className="row" style={{ gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setOpen(false)} disabled={busy}>
                Cancelar
              </button>
              <button className="primary" disabled={busy || !confirmedAt} onClick={() => void confirm()} title={!confirmedAt ? 'Informe a data da confirmação' : ''}>
                {busy ? 'Confirmando…' : 'Confirmar pedido'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
