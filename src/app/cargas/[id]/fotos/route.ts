import { and, count, eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { canAccessPlan } from '@/lib/access'
import { logAudit } from '@/lib/audit'
import { routeUser } from '@/lib/routeAuth'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

/**
 * Limites: a imagem chega reduzida do navegador (JPEG ~1600 px ≈ 300–800 KB, média ~1000 px, miniatura 360 px).
 * O envio inteiro (foto + média + miniatura) fica em até 3,5 MB — a Vercel corta o corpo em 4,5 MB.
 */
const MAX_BODY = BODY_LIMITS.photoUpload
const MAX_THUMB = 200 * 1024
const MAX_MEDIUM = 600 * 1024
const MAX_PHOTOS = 80
const TOO_BIG = `Foto grande demais para enviar (máx. ${fmtMB(MAX_BODY)} por foto, depois de reduzida). Tente de novo ou tire a foto com resolução menor.`

/** Tipo real pelo conteúdo (não pelo nome/cabeçalho enviado). */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/**
 * POST /cargas/:id/fotos — anexa FOTOS DO CARREGAMENTO (multipart: photo, thumb, caption, takenAt,
 * width, height). Só depois de a carga ter uma versão APROVADA; quem edita cargas e a Expedição.
 */
export async function POST(req: Request, ctx: RouteContext<'/cargas/[id]/fotos'>) {
  const u = await routeUser('uploadPhotos', { denied: 'Sem permissão para anexar fotos.' })
  if (u instanceof Response) return u
  // corpo declarado acima do limite: recusa antes de ler (folga para os campos do formulário)
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY + 32 * 1024) return Response.json({ error: TOO_BIG }, { status: 413 })
  const planId = Number((await ctx.params).id)
  if (!Number.isInteger(planId) || !(await canAccessPlan(u, planId))) return Response.json({ error: 'Carga não encontrada.' }, { status: 404 })
  const approved = await db.query.loadPlanVersions.findFirst({ where: and(eq(schema.loadPlanVersions.loadPlanId, planId), eq(schema.loadPlanVersions.status, 'APPROVED')) })
  if (!approved) return Response.json({ error: 'As fotos do carregamento são anexadas depois que a carga é aprovada.' }, { status: 409 })
  const [{ n }] = await db.select({ n: count() }).from(schema.loadPhotos).where(eq(schema.loadPhotos.loadPlanId, planId))
  if (n >= MAX_PHOTOS) return Response.json({ error: `Máximo de ${MAX_PHOTOS} fotos por carga.` }, { status: 409 })

  let fd: FormData
  try {
    fd = await req.formData()
  } catch {
    return Response.json({ error: 'Envio inválido (incompleto ou grande demais).' }, { status: 400 })
  }
  const photo = fd.get('photo')
  if (!(photo instanceof File)) return Response.json({ error: 'Nenhuma foto enviada.' }, { status: 400 })
  // foto + versão média + miniatura: o mesmo teto do navegador
  const sent = ['photo', 'medium', 'thumb'].reduce((s, k) => {
    const f = fd.get(k)
    return s + (f instanceof File ? f.size : 0)
  }, 0)
  if (sent > MAX_BODY) return Response.json({ error: TOO_BIG }, { status: 413 })
  const data = new Uint8Array(await photo.arrayBuffer())
  const mime = sniff(data)
  if (!mime) return Response.json({ error: 'Formato não suportado (use JPEG, PNG ou WebP).' }, { status: 415 })
  const thumbFile = fd.get('thumb')
  let thumb: Uint8Array | null = null
  if (thumbFile instanceof File && thumbFile.size > 0 && thumbFile.size <= MAX_THUMB) {
    const t = new Uint8Array(await thumbFile.arrayBuffer())
    thumb = sniff(t) ? t : null
  }
  // versão média (~1000 px) para o PDF
  const mediumFile = fd.get('medium')
  let medium: Uint8Array | null = null
  if (mediumFile instanceof File && mediumFile.size > 0 && mediumFile.size <= MAX_MEDIUM) {
    const m = new Uint8Array(await mediumFile.arrayBuffer())
    medium = sniff(m) === 'image/jpeg' || sniff(m) === 'image/png' ? m : null
  }
  const int = (k: string) => {
    const v = Number(fd.get(k))
    return Number.isInteger(v) && v > 0 && v < 20000 ? v : null
  }
  const caption = String(fd.get('caption') ?? '').trim().slice(0, 200) || null
  const takenRaw = Number(fd.get('takenAt'))
  const takenAt = Number.isFinite(takenRaw) && takenRaw > 0 ? new Date(takenRaw) : null
  const [row] = await db
    .insert(schema.loadPhotos)
    .values({ loadPlanId: planId, loadPlanVersionId: approved.id, mime, data: Buffer.from(data), thumb: thumb ? Buffer.from(thumb) : null, medium: medium ? Buffer.from(medium) : null, width: int('width'), height: int('height'), sizeBytes: data.length, caption, takenAt, createdBy: u.id })
    .returning({ id: schema.loadPhotos.id })
  await logAudit('load_plan', planId, 'photo_add', u.id, { photoId: row.id, bytes: data.length, version: approved.version })
  return Response.json({ ok: true, id: row.id })
}
