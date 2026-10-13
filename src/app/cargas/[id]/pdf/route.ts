import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import { logAudit } from '@/lib/audit'
import { buildOrderPdf } from '@/lib/pdf/orderPdf'
import { orderPdfData } from '@/lib/pdf/orderData'
import { loadPlanVersion } from '@/lib/planData'
import { canAccessPlan } from '@/lib/access'
import { productRank, productTechBySku } from '@/lib/catalog'
import { techSeals } from '@/lib/pdf/techSeals'
import { isPdfLang, PDF_LOGO_PATH } from '@/lib/pdf/i18n'
import { flagPng } from '@/lib/pdf/flags'
import { planValue, recordIssuedQuote } from '@/lib/loadPricing'
import { routeUser } from '@/lib/routeAuth'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

/** PDF com fotos e vistas 3D (pdf-lib + consultas de preço): folga acima do normal */
export const maxDuration = 120

const MB = 1024 * 1024
/** cada vista 3D (JPEG 1600×900 ≈ 150–400 KB): acima disso a imagem é descartada */
const MAX_IMAGE_BYTES = 1.5 * MB
/**
 * A resposta inteira cabe na Vercel (4,5 MB): fotos até ~2,8 MB somadas e, com as vistas 3D, até ~3,8 MB
 * de imagens no total; as demais fotos entram na contagem "+N foto(s) não incluída(s)".
 */
const PHOTO_BUDGET = 2.8 * MB
const IMAGES_BUDGET = 3.8 * MB
/** no máximo 24 fotos no PDF (e-mail/WhatsApp); as demais ficam no sistema */
const MAX_PHOTOS = 24

type Photo = { bytes: Uint8Array; caption: string | null; date: Date | null }

/** Fotos em ordem até o orçamento de bytes; o resto vira "omitidas". */
function withinBudget(all: Photo[], budget: number): { photos: Photo[]; omitted: number } {
  const photos: Photo[] = []
  let used = 0
  for (const p of all) {
    if (photos.length >= MAX_PHOTOS || used + p.bytes.length > budget) break
    photos.push(p)
    used += p.bytes.length
  }
  return { photos, omitted: all.length - photos.length }
}

/**
 * POST /cargas/:id/pdf?v=N&lang=pt|es|en  — corpo: { images: string[] } (data URLs JPEG/PNG capturadas do 3D, opcionais).
 * Gera o PDF do resumo do pedido a partir da versão SALVA.
 */
export async function POST(req: Request, ctx: RouteContext<'/cargas/[id]/pdf'>) {
  const u = await routeUser('viewPrices', { text: true, denied: 'Sem permissão para o PDF do pedido (com preços).' })
  if (u instanceof Response) return u
  const { id } = await ctx.params
  const url = new URL(req.url)
  const v = Number(url.searchParams.get('v')) || undefined
  const qlang = url.searchParams.get('lang')
  const lang = isPdfLang(qlang) ? qlang : 'pt'
  if (!(await canAccessPlan(u, Number(id)))) return new Response('Não encontrado', { status: 404 })
  const data = await loadPlanVersion(Number(id), v)
  if (!data) return new Response('Não encontrado', { status: 404 })

  let images: Uint8Array[] = []
  try {
    const body = (await req.json()) as { images?: unknown }
    const list = Array.isArray(body.images) ? body.images.slice(0, 2) : []
    images = list.flatMap((x) => {
      if (typeof x !== 'string') return []
      const m = x.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/)
      if (!m) return []
      const bytes = Uint8Array.from(Buffer.from(m[2], 'base64'))
      return bytes.length <= MAX_IMAGE_BYTES ? [bytes] : []
    })
  } catch {
    images = [] // sem imagens: o PDF sai só com os dados
  }
  const imagesBytes = images.reduce((s, b) => s + b.length, 0)

  // logo da Pacifil Brasil (public/brand); sem o arquivo, o PDF sai com o nome da empresa
  const logo = await readFile(path.join(process.cwd(), 'public', PDF_LOGO_PATH)).then((b) => new Uint8Array(b)).catch(() => null)
  // bandeira do país de destino (sem rede: o PDF sai sem ela)
  const flag = await flagPng(data.shipment?.destinationCountry)
  // preços: tabela vigente (não aprovada) ou congelados na aprovação
  const pv = await planValue(data)
  // fotos do carregamento (opcional: ?fotos=1) — versão média (~1000 px) mantém o PDF leve; sem ela, a foto
  // original (JPEG/PNG), lida do banco só nesse caso
  const p = schema.loadPhotos
  const allPhotos: Photo[] =
    url.searchParams.get('fotos') === '1'
      ? (
          await db
            .select({ medium: p.medium, original: sql<Buffer | null>`case when ${p.medium} is null and ${p.mime} in ('image/jpeg', 'image/png') then ${p.data} end`, caption: p.caption, takenAt: p.takenAt, createdAt: p.createdAt })
            .from(p)
            .where(eq(p.loadPlanId, Number(id)))
            .orderBy(asc(p.createdAt))
        ).flatMap((r) => {
          const b = r.medium ?? r.original
          return b ? [{ bytes: new Uint8Array(b), caption: r.caption, date: r.takenAt ?? r.createdAt }] : []
        })
      : []
  let { photos, omitted } = withinBudget(allPhotos, Math.max(0, Math.min(PHOTO_BUDGET, IMAGES_BUDGET - imagesBytes)))
  // selo PACIFIL NXT ao lado dos itens das famílias com SELO no Catálogo (Hidrosilo)
  const [rank, techBySku, seals] = await Promise.all([productRank(), productTechBySku(), techSeals()])
  const build = () => buildOrderPdf(orderPdfData(data, rank, pv.value, techBySku), images, { lang, logo, flag, photos, photosOmitted: omitted, seals, generatedBy: u.name })
  let pdf = await build()
  // rede de segurança: PDF acima do limite de resposta → menos fotos (proporcional ao excesso) até caber
  while (pdf.length > BODY_LIMITS.response && photos.length) {
    const keep = Math.min(photos.length - 1, Math.floor(photos.length * (BODY_LIMITS.response / pdf.length) * 0.9))
    photos = photos.slice(0, Math.max(0, keep))
    omitted = allPhotos.length - photos.length
    pdf = await build()
  }
  if (pdf.length > BODY_LIMITS.response)
    return new Response(`PDF grande demais para baixar (${fmtMB(pdf.length, true)}; máx. ${fmtMB(BODY_LIMITS.response)}). Gere sem as fotos ou sem as vistas 3D.`, { status: 413 })
  // cotação EMITIDA ao cliente = PDF de uma versão APROVADA (rascunho/revisão são prévias internas e não contam).
  // Preço e fatores usados ficam registrados para consulta futura (não bloqueia o PDF).
  const quoteId =
    data.v.status === 'APPROVED'
      ? await recordIssuedQuote(data, pv, u.id, lang).catch((e) => {
          console.error('cotação emitida não registrada', e)
          return null
        })
      : null
  await logAudit('load_plan_version', data.v.id, 'pdf', u.id, { images: images.length, lang, quoteId, photos: photos.length, photosOmitted: omitted, bytes: pdf.length })
  const name = `${lang === 'en' ? 'order' : 'pedido'}-${data.plan.name.replace(/[^\w.-]+/g, '_')}-V${data.v.version}.pdf`
  return new Response(Buffer.from(pdf), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  })
}
