import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db'
import { familyTech, TechDisplay } from '@/domain/technology'
import { techSeals } from '@/lib/pdf/techSeals'
import { canAccessArea } from '@/lib/areas'
import { routeUser } from '@/lib/routeAuth'
import { logAudit } from '@/lib/audit'
import { INCOTERMS } from '@/lib/constants'
import { priceListData } from '@/lib/priceList'
import { buildPriceListPdf } from '@/lib/pdf/priceListPdf'
import { isPdfLang, PDF_LOGO_PATH } from '@/lib/pdf/i18n'
import { BALANCE_WHEN_OPTIONS, paymentTermsErrors, PaymentTerms } from '@/domain/paymentTerms'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

/** PDF da lista (até 3.000 itens) com logo e selos: folga acima do normal */
export const maxDuration = 120

const body = z.object({
  families: z.array(z.string().max(80)).max(50),
  /** itens escolhidos (dentro das famílias); null = todos os itens das famílias */
  skus: z.array(z.string().min(1).max(80)).max(3000).nullable().default(null),
  categoryId: z.number().int().positive(),
  incoterm: z.string(),
  agentId: z.number().int().positive().nullable(),
  lang: z.string(),
  paymentTerms: z
    .object({ advancePct: z.number().min(0).max(100), balanceWhen: z.enum(BALANCE_WHEN_OPTIONS as [string, ...string[]]).nullable(), days: z.number().int().nullable(), note: z.string().max(300).nullable() })
    .nullable(),
  columns: z.object({ thickness: z.boolean(), box: z.boolean(), perPallet: z.boolean() }),
  description: z.string().max(600).nullable(),
  /** PACIFIL NXT: famílias com a menção (selo ou texto conforme o Catálogo) e o texto do quadro (null = sem NXT) */
  nxt: z.object({ families: z.array(z.string().max(80)).max(50), text: z.string().max(800) }).nullable().default(null),
})

/**
 * POST /precos-exportacao/lista — LISTA DE PREÇOS em PDF (categoria, Incoterm, agente opcional,
 * condição de pagamento, idioma, colunas, itens e descrição escolhidos na tela). Só quem vê preços (Exportação).
 */
export async function POST(req: Request) {
  const u = await routeUser('viewPrices', { denied: 'Sem permissão para listas de preços.' })
  if (u instanceof Response) return u
  if (!canAccessArea(u, 'EXPORT')) return Response.json({ error: 'Sem permissão para listas de preços.' }, { status: 403 })
  const p = body.safeParse(await req.json().catch(() => null))
  if (!p.success) return Response.json({ error: 'Dados inválidos.' }, { status: 400 })
  const o = p.data
  if (!INCOTERMS.includes(o.incoterm)) return Response.json({ error: 'Incoterm inválido.' }, { status: 400 })
  if (!isPdfLang(o.lang)) return Response.json({ error: 'Idioma inválido.' }, { status: 400 })
  const terms = o.paymentTerms as PaymentTerms | null
  if (terms) {
    const errs = paymentTermsErrors(terms)
    if (errs.length) return Response.json({ error: errs.join(' ') }, { status: 400 })
  }
  try {
    const data = await priceListData({ families: o.families, skus: o.skus, categoryId: o.categoryId, incoterm: o.incoterm, agentId: o.agentId, groupByWidth: true })
    if (!data.groups.length) return Response.json({ error: 'Nenhum produto escolhido para a lista.' }, { status: 400 })
    const logo = await readFile(path.join(process.cwd(), 'public', PDF_LOGO_PATH))
      .then((b) => new Uint8Array(b))
      .catch(() => null)
    // PACIFIL NXT: só famílias que são NXT no Catálogo; menção ou selo também vêm de lá
    let nxt: { families: Record<string, TechDisplay>; text: string; seal: Uint8Array | null } | null = null
    if (o.nxt && o.nxt.families.length) {
      const fams = await db.select({ name: schema.productFamilies.name, technology: schema.productFamilies.technology, technologyDisplay: schema.productFamilies.technologyDisplay }).from(schema.productFamilies).where(inArray(schema.productFamilies.name, o.nxt.families))
      const families: Record<string, TechDisplay> = {}
      for (const f of fams) {
        const t = familyTech(f)
        if (t?.key === 'NXT') families[f.name] = t.display
      }
      if (Object.keys(families).length) nxt = { families, text: o.nxt.text, seal: Object.values(families).includes('SEAL') ? ((await techSeals()).NXT ?? null) : null }
    }
    const pdf = await buildPriceListPdf(data, { lang: o.lang, logo, paymentTerms: terms, columns: o.columns, description: o.description, nxt, generatedBy: u.name })
    // a resposta precisa caber na função (Vercel: 4,5 MB)
    if (pdf.length > BODY_LIMITS.response) return Response.json({ error: `Lista grande demais para um PDF (${fmtMB(pdf.length, true)}; máx. ${fmtMB(BODY_LIMITS.response)}). Escolha menos famílias ou itens.` }, { status: 413 })
    await logAudit('price_list', null, 'pdf', u.id, { families: o.families, items: o.skus ? o.skus.length : 'todos', categoryId: o.categoryId, incoterm: o.incoterm, agentId: o.agentId, lang: o.lang, products: data.groups.reduce((s, g) => s + g.rows.length, 0) })
    const name = `${o.lang === 'en' ? 'price-list' : o.lang === 'es' ? 'lista-precios' : 'lista-precos'}-${o.incoterm}-${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })}.pdf`
    return new Response(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[lista de preços]', e)
    return Response.json({ error: e instanceof Error ? e.message : 'Não foi possível gerar a lista.' }, { status: 500 })
  }
}
