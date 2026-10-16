import { revalidatePath } from 'next/cache'
import { type CustomerApplyInput, validateCustomerApplyInput } from '@/domain/customerImport'
import { applyCustomerImport } from '@/lib/maintenance/customerImport'
import { MaintenanceError } from '@/lib/maintenance/deleteAllLoads'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'
import { fail, noStore, readUpload } from '../upload'

const text = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v : ''
}

/**
 * POST /admin/manutencao/clientes/aplicar — multipart: arquivo (o MESMO .xlsx da prévia), modo
 * (replace | update), sha256 (da prévia), simular ('1' = desfaz no fim), confirmacao (SUBSTITUIR /
 * ATUALIZAR), backupSalvo ('1') e backupSha256. Só o administrador principal.
 * Resposta: { ok: true, result } ou { ok: false, error }.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal importa os clientes.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  const up = await readUpload(req)
  if (up instanceof Response) return up
  const input: CustomerApplyInput = {
    mode: text(up.fd, 'modo') as CustomerApplyInput['mode'],
    fileSha256: text(up.fd, 'sha256'),
    dryRun: text(up.fd, 'simular') === '1',
    confirm: text(up.fd, 'confirmacao'),
    savedBackup: text(up.fd, 'backupSalvo') === '1',
    backupSha256: text(up.fd, 'backupSha256') || null,
  }
  const invalid = validateCustomerApplyInput(input)
  if (invalid) return fail(400, invalid)
  try {
    const result = await applyCustomerImport({ userId: u.id, file: up.file, expectedSha256: input.fileSha256, mode: input.mode, backupSha256: input.backupSha256, dryRun: input.dryRun })
    if (!input.dryRun) {
      // telas que listam clientes
      for (const p of ['/cadastros/clientes', '/cargas/nova', '/', '/exportacoes', '/admin/manutencao']) revalidatePath(p)
    }
    return Response.json({ ok: true, result }, { headers: noStore })
  } catch (e) {
    if (e instanceof MaintenanceError) return fail(409, e.message)
    console.error('[clientes pela planilha] aplicar', e)
    return fail(500, `Erro inesperado ao ${input.dryRun ? 'simular' : 'aplicar'}. Nada foi gravado.`)
  }
}
