import { eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { routeUser } from '@/lib/routeAuth'

/**
 * GET /avatar/:id — foto do usuário (só para quem está logado). A URL leva a versão (?v=), então pode ficar em cache.
 * Vale também com a senha temporária pendente: o menu da tela de troca de senha mostra a foto.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await routeUser(undefined, { text: true, allowPendingPassword: true })
  if (u instanceof Response) return u
  const { id } = await ctx.params
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, Number(id)), columns: { avatarImage: true } })
  const m = user?.avatarImage?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/)
  if (!m) return new Response('Sem foto', { status: 404 })
  return new Response(Buffer.from(m[2], 'base64'), { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400' } })
}
