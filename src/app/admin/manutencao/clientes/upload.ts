import 'server-only'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import type { UploadedFile } from '@/lib/maintenance/customerImport'

export const noStore = { 'Cache-Control': 'no-store' }
export const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: noStore })
const tooBig = (bytes: number) => fail(413, `Planilha grande demais (${fmtMB(bytes, true)}; máx. ${fmtMB(BODY_LIMITS.customerImport)}). Dica: apague as linhas vazias abaixo dos dados e salve de novo.`)

/**
 * Lê o envio multipart das rotas de clientes da Manutenção: a planilha no campo "arquivo" (+ os outros
 * campos). Devolve a Response de erro pronta (tamanho, envio incompleto, sem arquivo) ou os dados.
 */
export async function readUpload(req: Request): Promise<Response | { file: UploadedFile; fd: FormData }> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > BODY_LIMITS.customerImport + 64 * 1024) return tooBig(declared)
  let fd: FormData
  try {
    fd = await req.formData()
  } catch {
    return fail(400, 'Não foi possível ler o arquivo (envio incompleto ou grande demais). Tente de novo.')
  }
  const f = fd.get('arquivo')
  if (!(f instanceof File) || f.size === 0) return fail(400, 'Escolha a planilha dos clientes (.xlsx).')
  if (f.size > BODY_LIMITS.customerImport) return tooBig(f.size)
  return { file: { name: f.name || 'clientes.xlsx', buf: Buffer.from(await f.arrayBuffer()) }, fd }
}
