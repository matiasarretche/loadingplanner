import { isNotNull } from 'drizzle-orm'
import { db, schema } from '@/db'
import { Avatar } from '@/components/Avatar'
import { requireUser } from '@/lib/auth'
import { AREA_LABEL, userAreas } from '@/lib/areas'
import { ROLE_LABEL } from '@/lib/roles'
import { AvatarPicker } from './AvatarPicker'

/** Meu perfil: avatar (emoji ou foto), dados do usuário. */
export default async function PerfilPage() {
  const u = await requireUser()
  const others = await db.select({ id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar }).from(schema.users).where(isNotNull(schema.users.avatar))
  // emojis já usados por OUTROS usuários (não se repetem)
  const taken = Object.fromEntries(others.filter((o) => o.id !== u.id && o.avatar && !o.avatar.startsWith('foto:')).map((o) => [o.avatar!, o.name]))
  return (
    <>
      <div className="page-head">
        <h1>Meu perfil</h1>
      </div>
      <div className="panel" style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
        <Avatar avatar={u.avatar} name={u.name} size={64} />
        <div>
          <strong style={{ fontSize: 18 }}>{u.name}</strong>
          <div className="muted">{u.email}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {ROLE_LABEL[u.role]} · {userAreas(u).map((a) => AREA_LABEL[a]).join(' + ')}
          </div>
        </div>
      </div>
      <AvatarPicker current={u.avatar} taken={taken} />
    </>
  )
}
