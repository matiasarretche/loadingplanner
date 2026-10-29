import 'server-only'
import { fmtMB } from '@/components/intake/limits'
import { CARRIER_IMPORT_MAX_BYTES } from '@/domain/carrierImport'
import type { UploadedFile } from '@/lib/maintenance/carrierImport'

export const noStore = { 'Cache-Control': 'no-store' }
export const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: noStore })
const tooBig = (bytes: number) => fail(413, `Planilha grande demais (${fmtMB(bytes, true)}; máx. ${fmtMB(CARRIER_IMPORT_MAX_BYTES)}). Dica: apague as linhas vazias abaixo dos dados e salve de novo.`)

/**
 * Lê o envio multipart das rotas de transportadoras da Manutenção: a planilha no campo "arquivo" (+ os outros
 * campos). Devolve a Response de erro pronta (tamanho, envio incompleto, sem arquivo) ou os dados.
 */
export async function readUpload(req: Request): Promise<Response | { file: UploadedFile; fd: FormData }> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > CARRIER_IMPORT_MAX_BYTES + 64 * 1024) return tooBig(declared)
  let fd: FormData
  try {
    fd = await req.formData()
  } catch {
    return fail(400, 'Não foi possível ler o arquivo (envio incompleto ou grande demais). Tente de novo.')
  }
  const f = fd.get('arquivo')
  if (!(f instanceof File) || f.size === 0) return fail(400, 'Escolha a planilha das transportadoras (.xlsx).')
  if (f.size > CARRIER_IMPORT_MAX_BYTES) return tooBig(f.size)
  return { file: { name: f.name || 'transportadoras.xlsx', buf: Buffer.from(await f.arrayBuffer()) }, fd }
}
