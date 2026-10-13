'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { updateOrderRefAction } from '../actions'
import { orderRefFieldLabel, orderRefInitial, orderRefLabel } from '@/lib/orderRef'

/**
 * Referência do pedido (Proforma na exportação) no cabeçalho da carga, editável depois de criada.
 * Vale para o pedido inteiro (todas as unidades); o nome automático da carga acompanha.
 */
export function OrderRefField({ planId, area, value, editable }: { planId: number; area: string; value: string | null; editable: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = orderRefFieldLabel(area)

  function start() {
    setText(value ?? orderRefInitial(area))
    setError(null)
    setEditing(true)
  }
  async function save() {
    setBusy(true)
    setError(null)
    const r = await updateOrderRefAction(planId, text).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setEditing(false)
    router.refresh()
  }

  if (!editing)
    return (
      <span>
        {value ? orderRefLabel(value, area) : <span style={{ fontStyle: 'italic' }}>sem {label.toLowerCase()}</span>}
        {editable && (
          <button className="small" style={{ marginLeft: 4, padding: '0 6px' }} onClick={start} title={`Editar ${label.toLowerCase()} (vale para todas as unidades do pedido)`}>
            ✎
          </button>
        )}
      </span>
    )
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <small>{label}:</small>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) void save()
          if (e.key === 'Escape') setEditing(false)
        }}
        style={{ width: 180, padding: '2px 6px' }}
        placeholder={area === 'EXPORT' ? 'Proforma 1234' : ''}
        disabled={busy}
      />
      <button className="small primary" onClick={() => void save()} disabled={busy}>
        {busy ? '…' : 'Salvar'}
      </button>
      <button className="small" onClick={() => setEditing(false)} disabled={busy}>
        Cancelar
      </button>
      {error && <small style={{ color: 'var(--crit)' }}>{error}</small>}
    </span>
  )
}
