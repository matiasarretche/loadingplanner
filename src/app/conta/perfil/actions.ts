'use server'

import { createHash } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db, schema } from '@/db'
import { assertUser, AuthError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { AVATAR_EMOJIS, isPhotoDataUrl } from '@/lib/avatar'
import { isUniqueViolation } from '@/lib/dbErrors'

export type AvatarResult = { ok: true } | { ok: false; error: string }

/**
 * Define o avatar do próprio usuário: { emoji } da lista, { photo } (data URL já reduzida no navegador)
 * ou null (remove). Avatares não se repetem entre usuários (checagem + restrição única no banco).
 */
export async function saveAvatarAction(input: { emoji?: string; photo?: string } | null): Promise<AvatarResult> {
  try {
    const me = await assertUser()
    let avatar: string | null = null
    let avatarImage: string | null = null
    if (input?.emoji) {
      if (!AVATAR_EMOJIS.includes(input.emoji)) return { ok: false, error: 'Emoji inválido.' }
      avatar = input.emoji
    } else if (input?.photo) {
      if (!isPhotoDataUrl(input.photo)) return { ok: false, error: 'Foto inválida ou grande demais (use JPG/PNG; ela é reduzida automaticamente).' }
      avatar = `foto:${createHash('sha256').update(input.photo).digest('hex').slice(0, 24)}`
      avatarImage = input.photo
    }
    if (avatar) {
      const taken = await db.query.users.findFirst({ where: and(eq(schema.users.avatar, avatar), ne(schema.users.id, me.id)), columns: { name: true } })
      if (taken) return { ok: false, error: `Esse avatar já é usado por ${taken.name}. Escolha outro.` }
    }
    try {
      await db.update(schema.users).set({ avatar, avatarImage, updatedAt: new Date() }).where(eq(schema.users.id, me.id))
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: 'Esse avatar acabou de ser escolhido por outro usuário. Escolha outro.' }
      throw e
    }
    await logAudit('user', me.id, 'avatar', me.id, { avatar: avatar?.startsWith('foto:') ? 'foto' : avatar })
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    throw e
  }
}
