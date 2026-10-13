import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import { canAccessPlan } from '@/lib/access'
import { routeUser } from '@/lib/routeAuth'

/** acima disso a foto inteira não cabe na resposta da função (Vercel: 4,5 MB) → serve a versão média */
const MAX_FULL = 4 * 1024 * 1024

/**
 * GET /cargas/:id/fotos/:photoId[?thumb=1] — a foto do carregamento (ou a miniatura). Só para quem tem
 * acesso à carga. A URL não tem extensão de imagem: passa pela verificação de sessão.
 */
export async function GET(req: Request, ctx: RouteContext<'/cargas/[id]/fotos/[photoId]'>) {
  const u = await routeUser(undefined, { text: true })
  if (u instanceof Response) return u
  const { id, photoId } = await ctx.params
  const planId = Number(id)
  const pid = Number(photoId)
  if (!Number.isInteger(planId) || !Number.isInteger(pid) || !(await canAccessPlan(u, planId))) return new Response('Não encontrado', { status: 404 })
  const wantThumb = new URL(req.url).searchParams.get('thumb') === '1'
  const p = schema.loadPhotos
  const where = and(eq(p.id, pid), eq(p.loadPlanId, planId))
  const image = (bytes: Buffer, mime: string) =>
    new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=86400',
        'Content-Disposition': `inline; filename="carregamento-${planId}-${pid}.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  // versão reduzida (miniatura/média): JPEG ou PNG, conferidos no envio
  const reducedMime = (b: Buffer) => (b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : 'image/jpeg')
  // miniatura: lê só a miniatura (a foto inteira só se não houver miniatura)
  if (wantThumb) {
    const [t] = await db.select({ thumb: p.thumb }).from(p).where(where)
    if (!t) return new Response('Não encontrado', { status: 404 })
    if (t.thumb) return image(t.thumb, reducedMime(t.thumb))
  }
  // foto inteira (só se couber na resposta); acima do limite, a versão média (~1000 px) ou a miniatura
  const [info] = await db
    .select({ mime: p.mime, full: sql<Buffer | null>`case when octet_length(${p.data}) <= ${MAX_FULL} then ${p.data} end`, hasMedium: sql<boolean>`${p.medium} is not null`, hasThumb: sql<boolean>`${p.thumb} is not null` })
    .from(p)
    .where(where)
  if (!info) return new Response('Não encontrado', { status: 404 })
  if (info.full) return image(info.full, info.mime)
  const col = info.hasMedium ? p.medium : info.hasThumb ? p.thumb : null
  const [row] = col ? await db.select({ bytes: col }).from(p).where(where) : []
  return row?.bytes ? image(row.bytes, reducedMime(row.bytes)) : new Response('Foto grande demais para exibir.', { status: 413 })
}
