import { previewCarrierImport } from '@/lib/maintenance/carrierImport'
import { MaintenanceError } from '@/lib/maintenance/deleteAllLoads'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'
import { fail, noStore, readUpload } from '../upload'

/**
 * POST /admin/manutencao/transportadoras/previa — multipart: arquivo (.xlsx). Só o administrador principal.
 * Lê a planilha das transportadoras do ERP e devolve a PRÉVIA (erros, avisos, códigos novos, nomes que mudam,
 * cadastradas fora da planilha). NADA é gravado: a aplicação recebe o mesmo arquivo de novo (sha256).
 * Resposta: { ok: true, preview } ou { ok: false, error }.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal importa as transportadoras.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  const up = await readUpload(req)
  if (up instanceof Response) return up
  try {
    const preview = await previewCarrierImport(up.file)
    return Response.json({ ok: true, preview }, { headers: noStore })
  } catch (e) {
    if (e instanceof MaintenanceError) return fail(400, e.message)
    console.error('[transportadoras pela planilha] prévia', e)
    return fail(500, 'Erro inesperado ao ler a planilha. Nada foi gravado.')
  }
}
