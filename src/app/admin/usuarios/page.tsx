import { asc } from 'drizzle-orm'
import { db, schema } from '@/db'
import { dt } from '@/components/format'
import { requireUser } from '@/lib/auth'
import { ROLE_LABEL, ROLES } from '@/lib/roles'
import { AREA_LABEL, AREAS } from '@/lib/areas'
import { avatarRef } from '@/lib/avatar'
import { LOCK_MINUTES, lockMinutesLeft } from '@/lib/loginGuard'
import { Avatar } from '@/components/Avatar'
import { updateUserAction } from './actions'
import { NewUserForm, ResetPasswordButton } from './UserForms'

export default async function UsuariosPage() {
  const me = await requireUser('manageUsers')
  const users = await db.select().from(schema.users).orderBy(asc(schema.users.name))
  // locked_at fica gravado depois de vencer: só o bloqueio em vigor (menos de 15 min) aparece
  const now = new Date()
  return (
    <>
      <h1>Usuários</h1>
      <div className="panel" style={{ marginBottom: 16 }}>
        <NewUserForm roles={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Nome</th>
            <th>E-mail</th>
            <th>Perfil · áreas · ativo</th>
            <th>Senha</th>
            <th>Criado</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
              <td>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Avatar avatar={avatarRef(u.id, u.avatar)} name={u.name} size={26} /> {u.name}
                </span>
              </td>
              <td>{u.email}</td>
              <td>
                <form action={updateUserAction.bind(null, u.id)} className="row">
                  <select name="role" defaultValue={u.role} disabled={u.id === me.id}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  {AREAS.map((a) => (
                    <label key={a} className="check" title={u.role === 'ADMIN' ? 'Administrador vê todas as áreas' : undefined}>
                      <input type="checkbox" name="areas" value={a} defaultChecked={u.areas.includes(a)} disabled={u.id === me.id} /> {AREA_LABEL[a]}
                    </label>
                  ))}
                  <label className="check">
                    <input type="checkbox" name="active" defaultChecked={u.active} disabled={u.id === me.id} /> ativo
                  </label>
                  {u.id !== me.id && <button className="small">Salvar</button>}
                </form>
              </td>
              <td>
                {lockMinutesLeft(u.lockedAt, now) > 0 && (
                  <span className="badge CRITICAL" title={`Bloqueada por muitas senhas erradas vindas de vários endereços. Libera sozinha ${LOCK_MINUTES} minutos depois do bloqueio; redefinir a senha também desbloqueia, mas obriga o usuário a trocá-la.`}>
                    🔒 bloqueada · {lockMinutesLeft(u.lockedAt, now)} min
                  </span>
                )} {u.mustChangePassword && <span className="badge WARNING">troca pendente</span>} {u.id !== me.id && <ResetPasswordButton userId={u.id} />}
              </td>
              <td>{dt(u.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
