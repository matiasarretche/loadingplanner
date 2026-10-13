import 'server-only'
import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { db, schema } from '@/db'
import { can, Permission, Role } from './roles'
import type { Area } from './areas'
import { avatarRef, AvatarRef } from './avatar'
import { readSession } from './session'

export interface CurrentUser {
  id: number
  email: string
  name: string
  role: Role
  mustChangePassword: boolean
  /** áreas de trabalho (Exportação / Mercado Interno); o ADMIN vê todas */
  areas: Area[]
  /** emoji, URL da foto ou null (iniciais) */
  avatar: AvatarRef
}

/** Camada de acesso a dados: valida a sessão contra o banco (usuário ativo). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const s = await readSession()
  if (!s) return null
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, s.uid) })
  // conta inativa ou senha trocada/redefinida depois deste login (sessão antiga) → fora.
  // O bloqueio por senhas erradas (15 min) só impede NOVOS logins: as sessões abertas continuam
  // (senão qualquer um na internet derrubaria o usuário legítimo errando a senha dele).
  if (!u || !u.active || (s.sv ?? 0) !== u.sessionVersion) return null
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword, areas: u.areas, avatar: avatarRef(u.id, u.avatar) }
})

/** Para páginas: redireciona ao login / troca de senha. */
export async function requireUser(permission?: Permission): Promise<CurrentUser> {
  const u = await getCurrentUser()
  if (!u) redirect('/login')
  if (u.mustChangePassword) redirect('/conta/senha')
  if (permission && !can[permission](u.role)) redirect('/?erro=permissao')
  return u
}

export class AuthError extends Error {}

/** Para Server Actions: lança erro (nunca confiar só na UI). Senha temporária: nada até trocá-la. */
export async function assertUser(permission?: Permission, o: { allowPendingPassword?: boolean } = {}): Promise<CurrentUser> {
  const u = await getCurrentUser()
  if (!u) throw new AuthError('Sessão expirada. Entre novamente.')
  if (u.mustChangePassword && !o.allowPendingPassword) throw new AuthError('Defina uma nova senha antes de continuar (Senha).')
  if (permission && !can[permission](u.role)) throw new AuthError('Você não tem permissão para esta ação.')
  return u
}
