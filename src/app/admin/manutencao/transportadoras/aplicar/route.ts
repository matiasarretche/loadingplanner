import { revalidatePath } from 'next/cache'
import { type CarrierApplyInput, validateCarrierApplyInput } from '@/domain/carrierImport'
import { applyCarrierImport } from '@/lib/maintenance/carrierImport'
import { MaintenanceError } from '@/lib/maintenance/deleteAllLoads'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'
import { fail, noStore, readUpload } from '../upload'

const text = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v : ''
}

/**
 * POST /admin/manutencao/transportadoras/aplicar — multipart: arquivo (o MESMO .xlsx da prévia), sha256 (da
 * prévia), simular ('1' = desfaz no fim) e confirmacao (ATUALIZAR). Só o administrador principal.
 * Atualiza pelo código: cria os códigos novos e renomeia os existentes cujo nome mudou; nunca apaga.
 * Resposta: { ok: true, result } ou { ok: false, error }.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal importa as transportadoras.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  const up = await readUpload(req)
  if (up instanceof Response) return up
  const input: CarrierApplyInput = {
    fileSha256: text(up.fd, 'sha256'),
    dryRun: text(up.fd, 'simular') === '1',
    confirm: text(up.fd, 'confirmacao'),
  }
  const invalid = validateCarrierApplyInput(input)
  if (invalid) return fail(400, invalid)
  try {
    const result = await applyCarrierImport({ userId: u.id, file: up.file, expectedSha256: input.fileSha256, dryRun: input.dryRun })
    if (!input.dryRun) {
      // telas que listam ou escolhem transportadoras
      for (const p of ['/cadastros/transportadoras', '/cargas/nova', '/', '/exportacoes', '/admin/manutencao']) revalidatePath(p)
    }
    return Response.json({ ok: true, result }, { headers: noStore })
  } catch (e) {
    if (e instanceof MaintenanceError) return fail(409, e.message)
    console.error('[transportadoras pela planilha] aplicar', e)
    return fail(500, `Erro inesperado ao ${input.dryRun ? 'simular' : 'aplicar'}. Nada foi gravado.`)
  }
}
