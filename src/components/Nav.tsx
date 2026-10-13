import Image from 'next/image'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { can, canSeeExports, ROLE_LABEL } from '@/lib/roles'
import { logoutAction } from '@/app/login/actions'
import { NavLinks } from './NavLinks'
import { Avatar } from './Avatar'

export async function Nav() {
  const u = await getCurrentUser()
  if (!u) return null
  return (
    <header className="topbar">
      <NavLinks
        home={<Image src="/brand/pacifil-brasil-branco.png" alt="Pacifil Brasil" width={56} height={28} priority />}
        links={[
          // seguimento das exportações confirmadas: primeiro da lista (uso diário da equipe de exportação)
          ...(canSeeExports(u) ? [{ href: '/exportacoes', label: 'Exportações' }] : []),
          { href: '/catalogo', label: 'Catálogo logístico' },
          ...((u.role === 'ADMIN' || u.areas.includes('EXPORT')) && can.viewPrices(u.role) ? [{ href: '/precos-exportacao', label: 'Preços exportação' }] : []),
          { href: '/cadastros', label: 'Cadastros' },
          ...(can.manageUsers(u.role) ? [{ href: '/admin/usuarios', label: 'Usuários' }] : []),
          // importação do catálogo oficial e exclusão de todas as cargas (só o administrador principal)
          ...(can.manageUsers(u.role) ? [{ href: '/admin/manutencao', label: 'Manutenção' }] : []),
        ]}
        user={
          <div className="user">
            <Link href="/conta/perfil" className="me" title={`${u.email} · ${ROLE_LABEL[u.role]} · Meu perfil (avatar)`}>
              <Avatar avatar={u.avatar} name={u.name} size={28} />
              <span>
                {/* só o nome do perfil; a explicação fica no título (tooltip) */}
                {u.name} · <small>{ROLE_LABEL[u.role].replace(/\s*\(.*\)\s*$/, '')}</small>
              </span>
            </Link>
            <Link href="/conta/senha">Senha</Link>
            <form action={logoutAction}>
              <button className="link">Sair</button>
            </form>
          </div>
        }
      />
    </header>
  )
}
