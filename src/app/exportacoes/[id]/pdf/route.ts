import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { SUMMARY_MESSAGE_MAX, SUMMARY_SECTIONS, todayBR } from '@/domain/exportTracking'
import { recordSummaryEvent, trackingSummaryData } from '@/lib/exportTracking'
import { flagPng } from '@/lib/pdf/flags'
import { PDF_LOGO_PATH } from '@/lib/pdf/i18n'
import { buildTrackingSummaryPdf, SUMMARY_LANG_NAME } from '@/lib/pdf/trackingPdf'
import { canSeeExports } from '@/lib/roles'
import { routeUser } from '@/lib/routeAuth'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

/** PDF leve (sem imagens além do logo e da bandeira), mas com consultas de várias cargas do pedido */
export const maxDuration = 60

const body = z.object({
  lang: z.enum(['es', 'pt', 'en']),
  sections: z.array(z.enum(SUMMARY_SECTIONS)).min(1).max(SUMMARY_SECTIONS.length),
  /** "Mensagem ao cliente" (quadro no início do PDF) */
  message: z.string().max(SUMMARY_MESSAGE_MAX).nullable().default(null),
  /** um resumo só com todas as cargas do pedido que têm seguimento */
  includeSiblings: z.boolean().default(false),
})

const FILE_PREFIX = { es: 'estado-embarque', pt: 'status-embarque', en: 'shipment-status' } as const

/** referência no nome do arquivo: sem acentos, só letras, números, ponto e hífen */
const fileRef = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)

/**
 * POST /exportacoes/:id/pdf — RESUMO PARA O CLIENTE ("Status do embarque") em PDF.
 * Corpo JSON: { lang, sections, message, includeSiblings }. Só quem vê o módulo de exportações e a operação
 * (área). O conteúdo vem de trackingSummaryData (DTO seguro: nada interno). Depois de gerar, registra no
 * histórico de cada operação incluída: "Resumo para o cliente gerado (Español|Português|English)".
 * Header X-Summary-Operations: ids das operações incluídas (contexto do envio por e-mail).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await routeUser()
  if (u instanceof Response) return u
  if (!canSeeExports(u)) return Response.json({ ok: false, error: 'Disponível só para usuários da área de Exportação.' }, { status: 403 })
  const { id } = await ctx.params
  const opId = Number(id)
  if (!Number.isInteger(opId) || opId <= 0) return Response.json({ ok: false, error: 'Operação não encontrada.' }, { status: 404 })
  const p = body.safeParse(await req.json().catch(() => null))
  if (!p.success) return Response.json({ ok: false, error: 'Dados inválidos.' }, { status: 400 })
  const o = p.data
  try {
    const data = await trackingSummaryData(opId, u, { includeSiblings: o.includeSiblings })
    if (!data) return Response.json({ ok: false, error: 'Operação não encontrada.' }, { status: 404 })
    // logo (public/brand) e bandeira do destino: sem eles, o PDF sai com o nome da empresa / sem bandeira
    const [logo, flag] = await Promise.all([
      readFile(path.join(process.cwd(), 'public', PDF_LOGO_PATH))
        .then((b) => new Uint8Array(b))
        .catch(() => null),
      flagPng(data.country),
    ])
    const pdf = await buildTrackingSummaryPdf(data, { lang: o.lang, logo, flag, sections: o.sections, message: o.message, generatedBy: u.name })
    if (pdf.length > BODY_LIMITS.response) return Response.json({ ok: false, error: `PDF grande demais (${fmtMB(pdf.length, true)}; máx. ${fmtMB(BODY_LIMITS.response)}). Desmarque “Incluir as outras cargas do pedido” ou a seção de produtos.` }, { status: 413 })

    // histórico de cada operação incluída (o PDF sai mesmo se o registro falhar)
    try {
      const logged = await recordSummaryEvent(data.operationIds, u, 'summary', `Resumo para o cliente gerado (${SUMMARY_LANG_NAME[o.lang]})`)
      for (const x of logged) revalidatePath(`/exportacoes/${x}`)
    } catch (e) {
      console.error('[resumo para o cliente: histórico]', e)
    }

    const ref = fileRef(data.orderRef ?? data.units[0]?.containerNumber ?? '') || String(opId)
    const name = `${FILE_PREFIX[o.lang]}-${ref}-${todayBR()}.pdf`
    return new Response(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
        'X-Summary-Operations': data.operationIds.join(','),
      },
    })
  } catch (e) {
    console.error('[resumo para o cliente]', e)
    return Response.json({ ok: false, error: 'Não foi possível gerar o resumo.' }, { status: 500 })
  }
}
