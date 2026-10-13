'use server'

import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db, schema } from '@/db'
import { assertUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { isUniqueViolation } from '@/lib/dbErrors'
import { Role, ROLES } from '@/lib/roles'
import { Area, AREAS } from '@/lib/areas'

/** áreas marcadas no formulário (checkboxes "areas"); ao menos uma */
const areasOf = (fd: FormData): Area[] => AREAS.filter((a) => fd.getAll('areas').includes(a))

export interface UserFormState {
  error?: string
  /** senha temporária mostrada UMA vez ao administrador */
  tempPassword?: string
  email?: string
}

function tempPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join('')
}

export async function createUserAction(_: UserFormState, fd: FormData): Promise<UserFormState> {
  const me = await assertUser('manageUsers')
  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const name = String(fd.get('name') ?? '').trim()
  const role = String(fd.get('role') ?? '') as Role
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'E-mail inválido.' }
  if (!name) return { error: 'Informe o nome.' }
  if (!ROLES.includes(role)) return { error: 'Perfil inválido.' }
  const areas = areasOf(fd)
  if (!areas.length && role !== 'ADMIN') return { error: 'Marque ao menos uma área (Exportação / Mercado Interno).' }
  const pw = tempPassword()
  try {
    const [row] = await db
      .insert(schema.users)
      .values({ email, name, role, areas: areas.length ? areas : [...AREAS], passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: true, createdBy: me.id, updatedBy: me.id })
      .returning({ id: schema.users.id })
    await logAudit('user', row.id, 'create', me.id, { email, role, areas })
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'Já existe um usuário com este e-mail.' }
    throw e
  }
  revalidatePath('/admin/usuarios')
  return { tempPassword: pw, email }
}

export async function resetPasswordAction(userId: number, _: UserFormState): Promise<UserFormState> {
  const me = await assertUser('manageUsers')
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) })
  if (!u) return { error: 'Usuário não encontrado.' }
  const pw = tempPassword()
  await db
    .update(schema.users)
    .set({ passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: true, sessionVersion: u.sessionVersion + 1, failedLogins: 0, lockedAt: null, updatedBy: me.id, updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
  await logAudit('user', userId, 'reset_password', me.id)
  return { tempPassword: pw, email: u.email }
}

export async function updateUserAction(userId: number, fd: FormData) {
  const me = await assertUser('manageUsers')
  const role = String(fd.get('role') ?? '') as Role
  const active = fd.get('active') === 'on'
  if (!ROLES.includes(role)) return
  if (userId === me.id && (role !== 'ADMIN' || !active)) return // não remover o próprio acesso de admin
  const areas = areasOf(fd)
  if (!areas.length && role !== 'ADMIN') return
  await db.update(schema.users).set({ role, active, areas: areas.length ? areas : [...AREAS], updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.users.id, userId))
  await logAudit('user', userId, 'update', me.id, { role, active, areas })
  revalidatePath('/admin/usuarios')
}
