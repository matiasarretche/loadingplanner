import { interpretCustomerOrder, INTAKE_LIMITS } from '@/lib/ai/intake'
import { OrderParseError } from '@/lib/ai/orderParser'
import { routeUser } from '@/lib/routeAuth'
import { fmtMB } from '@/components/intake/limits'

/** leitura com a IA (várias rodadas do modelo + PDFs/fotos): até o teto do plano (Vercel Hobby/Fluid: 300 s) */
export const maxDuration = 300

/**
 * POST /cargas/ia/interpretar — multipart: text (opcional) + files[] (fotos, PDF, .xlsx, .csv, .txt).
 * Rota (e não server action) porque os anexos passam do limite de corpo das actions. Nada é gravado.
 * O navegador reduz as fotos e soma os tamanhos antes de enviar (máx. 4 MB; a Vercel corta em 4,5 MB).
 */
export async function POST(req: Request) {
  const user = await routeUser('editPlans')
  if (user instanceof Response) return user
  // corpo declarado acima do limite: responde antes de ler (folga para os campos do formulário)
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > INTAKE_LIMITS.totalBytes + 64 * 1024)
    return Response.json({ ok: false, error: `Anexos grandes demais no total (máx. ${fmtMB(INTAKE_LIMITS.totalBytes)}). Remova algum arquivo, envie só as páginas do pedido em PDF ou uma captura de tela.` }, { status: 413 })
  try {
    let fd: FormData
    try {
      fd = await req.formData()
    } catch {
      return Response.json({ ok: false, error: 'Não foi possível ler os anexos (envio incompleto ou grande demais). Tente de novo com menos arquivos.' }, { status: 400 })
    }
    const text = String(fd.get('text') ?? '')
    const a = String(fd.get('area') ?? '')
    const area = a === 'EXPORT' || a === 'DOMESTIC' ? a : undefined
    const files = fd.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0)
    const result = await interpretCustomerOrder(user, { text, files, area })
    return Response.json({ ok: true, result })
  } catch (e) {
    if (e instanceof OrderParseError) return Response.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[pedido do cliente IA]', e)
    return Response.json({ ok: false, error: 'Erro inesperado ao interpretar o pedido.' }, { status: 500 })
  }
}
