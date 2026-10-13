'use client'

import { useActionState } from 'react'
import { createUserAction, resetPasswordAction, UserFormState } from './actions'

function TempPassword({ s }: { s: UserFormState }) {
  if (!s.tempPassword) return null
  return (
    <div className="alert ok">
      Senha temporária de <strong>{s.email}</strong>: <code style={{ fontSize: 15 }}>{s.tempPassword}</code> — informe ao usuário por um canal seguro. Ela não será exibida novamente e
      deverá ser trocada no primeiro acesso.
    </div>
  )
}

export function NewUserForm({ roles }: { roles: { value: string; label: string }[] }) {
  const [state, action, pending] = useActionState(createUserAction, {})
  return (
    <>
      <form action={action} className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field">
          Nome
          <input name="name" required />
        </label>
        <label className="field">
          E-mail
          <input name="email" type="email" required style={{ width: 240 }} />
        </label>
        <label className="field">
          Perfil
          <select name="role" defaultValue="EXPORT_ASSISTANT">
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="row" style={{ border: 'none', padding: 0, margin: 0, gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Áreas</span>
          <label className="check">
            <input type="checkbox" name="areas" value="EXPORT" defaultChecked /> Exportação
          </label>
          <label className="check">
            <input type="checkbox" name="areas" value="DOMESTIC" /> Mercado Interno
          </label>
        </fieldset>
        <button className="primary" disabled={pending}>
          Criar usuário
        </button>
        {state.error && <span className="field-error">{state.error}</span>}
      </form>
      <TempPassword s={state} />
    </>
  )
}

export function ResetPasswordButton({ userId }: { userId: number }) {
  const [state, action, pending] = useActionState(resetPasswordAction.bind(null, userId), {})
  return (
    <>
      <form action={action} style={{ display: 'inline' }}>
        <button className="small" disabled={pending}>
          Redefinir senha
        </button>
      </form>
      {state.error && <span className="field-error">{state.error}</span>}
      <TempPassword s={state} />
    </>
  )
}
