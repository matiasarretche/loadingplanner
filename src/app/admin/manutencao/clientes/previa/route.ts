import { previewCustomerImport } from '@/lib/maintenance/customerImport'
import { MaintenanceError } from '@/lib/maintenance/deleteAllLoads'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'
import { fail, noStore, readUpload } from '../upload'

/**
 * POST /admin/manutencao/clientes/previa — multipart: arquivo (.xlsx). Só o administrador principal.
 * Lê a planilha dos clientes de exportação e devolve a PRÉVIA (erros, avisos, o que cada modo faria e se há
 * pedidos bloqueando). NADA é gravado: a aplicação recebe o mesmo arquivo de novo (conferido pelo sha256).
 * Resposta: { ok: true, preview } ou { ok: false, error }.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal importa os clientes.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  const up = await readUpload(req)
  if (up instanceof Response) return up
  try {
    const preview = await previewCustomerImport(up.file)
    return Response.json({ ok: true, preview }, { headers: noStore })
  } catch (e) {
    if (e instanceof MaintenanceError) return fail(400, e.message)
    console.error('[clientes pela planilha] prévia', e)
    return fail(500, 'Erro inesperado ao ler a planilha. Nada foi gravado.')
  }
}
