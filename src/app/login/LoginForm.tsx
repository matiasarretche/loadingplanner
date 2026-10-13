'use client'

import { useActionState } from 'react'
import { LOCK_MINUTES, PAIR_MAX_FAILURES } from '@/lib/loginGuard'
import { loginAction } from './actions'

/** resetByEmail: o servidor tem e-mail configurado (o bloqueio envia o link de redefinição). */
export function LoginForm({ resetByEmail }: { resetByEmail: boolean }) {
  const [state, action, pending] = useActionState(loginAction, {})
  return (
    <form action={action} className="grid">
      {state.error && (
        <div className="alert error" role="alert">
          {state.error}
        </div>
      )}
      <label className="field">
        E-mail
        <input name="email" type="email" autoComplete="username" required autoFocus />
      </label>
      <label className="field">
        Senha
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="primary" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
      <small>
        Contas são criadas pelo administrador. Após {PAIR_MAX_FAILURES} senhas erradas o login da conta fica bloqueado nesta rede por até {LOCK_MINUTES} minutos
        {resetByEmail ? ' e enviamos ao e-mail da conta um link para redefinir a senha.' : '; se esqueceu a senha, peça ao administrador para redefini-la.'}
      </small>
    </form>
  )
}
