'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { resetWithTokenAction } from '../login/actions'

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetWithTokenAction, {})
  if (state.ok)
    return (
      <div className="grid">
        <div className="alert ok">{state.ok}</div>
        <Link className="btn primary" href="/login">
          Ir para o login
        </Link>
      </div>
    )
  return (
    <form action={action} className="grid">
      {state.error && <div className="alert error">{state.error}</div>}
      <input type="hidden" name="token" value={token} />
      <label className="field">
        Nova senha (mín. 10 caracteres)
        <input name="next" type="password" autoComplete="new-password" required minLength={10} autoFocus />
      </label>
      <label className="field">
        Confirmar a nova senha
        <input name="confirm" type="password" autoComplete="new-password" required minLength={10} />
      </label>
      <button className="primary" disabled={pending || !token}>
        {pending ? 'Gravando…' : 'Definir nova senha'}
      </button>
    </form>
  )
}
