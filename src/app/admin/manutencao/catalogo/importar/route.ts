import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { createCatalogImportPreview } from '@/lib/catalogImport/preview'
import { ImportFileError } from '@/lib/catalogImport/readSheets'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'

/** a planilha de produtos declara ~1 milhão de linhas: a leitura completa leva alguns segundos (teto da Vercel: 300 s) */
export const maxDuration = 300

const noStore = { 'Cache-Control': 'no-store' }
const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: noStore })
const tooBig = (bytes: number) => fail(413, `Planilhas grandes demais (${fmtMB(bytes, true)}; máx. ${fmtMB(BODY_LIMITS.catalogImport)}). Dica: apague as linhas vazias abaixo dos dados e salve de novo.`)

/**
 * POST /admin/manutencao/catalogo/importar — multipart: produtos (.xlsx) + caixas (.xlsx).
 * Lê as planilhas, monta o plano e grava a PRÉVIA (catalog_import); o catálogo não muda.
 * Resposta: { ok: true, id } (a tela abre /admin/manutencao/catalogo/{id}) ou { ok: false, error }.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal importa o catálogo.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > BODY_LIMITS.catalogImport) return tooBig(declared)
  let fd: FormData
  try {
    fd = await req.formData()
  } catch {
    return fail(400, 'Não foi possível ler os arquivos (envio incompleto ou grande demais). Tente de novo.')
  }
  const produtos = fd.get('produtos')
  const caixas = fd.get('caixas')
  if (!(produtos instanceof File) || produtos.size === 0) return fail(400, 'Escolha a planilha de PRODUTOS (.xlsx).')
  if (!(caixas instanceof File) || caixas.size === 0) return fail(400, 'Escolha a TABELA DE CAIXAS (.xlsx).')
  if (produtos.size + caixas.size > BODY_LIMITS.catalogImport) return tooBig(produtos.size + caixas.size)
  try {
    const { id } = await createCatalogImportPreview(
      {
        products: { name: produtos.name || 'produtos.xlsx', buf: Buffer.from(await produtos.arrayBuffer()) },
        boxes: { name: caixas.name || 'caixas.xlsx', buf: Buffer.from(await caixas.arrayBuffer()) },
      },
      u,
    )
    return Response.json({ ok: true, id }, { headers: noStore })
  } catch (e) {
    if (e instanceof ImportFileError) return fail(400, e.message)
    console.error('[importação do catálogo]', e)
    return fail(500, 'Erro inesperado ao ler as planilhas. Nada foi gravado no catálogo.')
  }
}
