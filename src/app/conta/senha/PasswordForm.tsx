'use client'

import { useActionState } from 'react'
import { changePasswordAction } from '@/app/login/actions'

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, {})
  return (
    <form action={action} className="grid">
      {state.error && <div className="alert error">{state.error}</div>}
      <label className="field">
        Senha atual
        <input name="current" type="password" autoComplete="current-password" required />
      </label>
      <label className="field">
        Nova senha (mín. 10 caracteres)
        <input name="next" type="password" autoComplete="new-password" required minLength={10} />
      </label>
      <label className="field">
        Confirmar nova senha
        <input name="confirm" type="password" autoComplete="new-password" required />
      </label>
      <button className="primary" disabled={pending}>
        Salvar
      </button>
    </form>
  )
}
