'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { undoConfirmationAction } from '../actions'

/**
 * "Desfazer confirmação": só enquanto o status é “Pedido confirmado”. Exclui a operação e o histórico dela
 * (a carga continua aprovada e pode ser confirmada de novo); depois volta para a carga, onde aparece de novo
 * "Confirmar pedido" (a página desta operação deixa de existir).
 */
export function UndoButton({ id }: { id: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function undo() {
    if (
      !confirm(
        'Desfazer a confirmação do pedido desta carga?\n\nO seguimento desta carga e todo o histórico dele serão excluídos. A carga continua aprovada e pode ser confirmada de novo. As outras cargas do pedido não mudam.',
      )
    )
      return
    setBusy(true)
    setError(null)
    const r = await undoConfirmationAction(id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    if (!r.ok) {
      setBusy(false)
      return setError(r.error)
    }
    router.push(`/cargas/${r.loadPlanId}`)
  }

  return (
    <>
      <button type="button" className="small danger" onClick={() => void undo()} disabled={busy} aria-busy={busy} title="Possível enquanto o status for “Pedido confirmado”">
        {busy ? 'Desfazendo…' : 'Desfazer confirmação'}
      </button>
      {error && (
        <small role="alert" style={{ color: 'var(--crit)', flex: '1 1 100%', textAlign: 'right' }}>
          {error}
        </small>
      )}
    </>
  )
}
