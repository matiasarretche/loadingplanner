import { and, count, eq, gte, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db, schema } from '@/db'
import type { CurrentUser } from '@/lib/auth'
import { recordSummaryEvent } from '@/lib/exportTracking'
import { mailConfigured, sendMail } from '@/lib/mailer'
import { routeUser } from '@/lib/routeAuth'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

/** envio SMTP com anexo de até ~4 MB: folga para servidores de e-mail lentos */
export const maxDuration = 60

/**
 * POST /email/pdf — envia um PDF gerado na plataforma por e-mail (multipart: to, cc, subject, message, file).
 * Conta SMTP da empresa nas variáveis do servidor (nunca no navegador):
 *   SMTP_HOST, SMTP_PORT (587 ou 465), SMTP_USER, SMTP_PASS, SMTP_FROM (ex.: "Pacifil Exportação <exportacao@pacifil.com.br>")
 *   SMTP_SECURE=true para a porta 465 (opcional).
 * A resposta do cliente vai para o e-mail do usuário que enviou (Reply-To).
 * Limites: PDF de até 4,2 MB (a Vercel corta o corpo em 4,5 MB) e no máximo DAILY_CAP envios por usuário em 24 h.
 */
const MAX_BYTES = BODY_LIMITS.emailPdf
const DAILY_CAP = 40
/** namespace do advisory lock do envio de e-mail (2º número = id do usuário) */
const EMAIL_LOCK = 7301
/** envio reservado antes do SMTP e envio concluído: os dois contam no limite diário */
const SENDING = 'pdf_sending'
const SENT = 'pdf_sent'
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

const list = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

const TOO_BIG = `PDF grande demais para enviar pelo servidor (máx. ${fmtMB(MAX_BYTES)}). Use “Baixar” e anexe no seu e-mail, ou “Compartilhar”; ou gere o PDF com menos fotos.`

const log = schema.auditLog
const CAP_MSG = `Limite diário de envios por e-mail atingido (${DAILY_CAP} em 24 h). Use “Baixar” e anexe no seu e-mail, ou tente mais tarde.`

/** envios de PDF deste usuário nas últimas 24 h: concluídos e em andamento (auditoria 'pdf_sent' / 'pdf_sending') */
async function sentLast24h(q: Pick<typeof db, 'select'>, userId: number): Promise<number> {
  const [r] = await q
    .select({ n: count() })
    .from(log)
    .where(and(eq(log.userId, userId), eq(log.entity, 'email'), inArray(log.action, [SENT, SENDING]), gte(log.at, new Date(Date.now() - 86_400_000))))
  return r?.n ?? 0
}

/**
 * Reserva um envio dentro do limite diário ANTES do SMTP (contagem + registro atômicos por usuário): requisições
 * em paralelo não furam o limite. null = limite atingido. O advisory lock vale só durante a transação, então
 * funciona pelo pooler do Neon (PgBouncer em modo transação).
 */
async function reserveSend(userId: number, diff: Record<string, unknown>): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EMAIL_LOCK}, ${userId})`)
    if ((await sentLast24h(tx, userId)) >= DAILY_CAP) return null
    const [row] = await tx.insert(log).values({ entity: 'email', entityId: null, action: SENDING, userId, diff }).returning({ id: log.id })
    return row.id
  })
}

/** Fecha a reserva com o resultado: 'pdf_sent' ou 'pdf_error' (falha não gasta cota). */
async function finishSend(id: number, action: typeof SENT | 'pdf_error', extra?: Record<string, unknown>) {
  await db
    .update(log)
    .set(extra ? { action, diff: sql`coalesce(${log.diff}, '{}'::jsonb) || ${JSON.stringify(extra)}::jsonb` } : { action })
    .where(eq(log.id, id))
}

/** contexto opcional do documento (campo "context" do formulário, JSON) — ver PdfEmailContext em PdfPreview */
const emailContext = z.object({ kind: z.literal('export-summary'), operationIds: z.array(z.number().int().positive()).min(1).max(50) })

/**
 * Depois de um envio CONCLUÍDO: resumo para o cliente das Exportações → "Resumo enviado ao cliente por e-mail
 * (destinatários)" no histórico das operações que o usuário vê. Contexto ausente ou inválido: ignorado em
 * silêncio; uma falha aqui não muda a resposta (o e-mail já saiu).
 */
async function logContext(raw: FormDataEntryValue | null, u: CurrentUser, to: string[], cc: string[]) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const c = emailContext.safeParse(parsed)
  if (!c.success) return
  try {
    const who = [to.join(', '), cc.length ? `cc: ${cc.join(', ')}` : ''].filter(Boolean).join('; ')
    const logged = await recordSummaryEvent(c.data.operationIds, u, 'summary_sent', `Resumo enviado ao cliente por e-mail (${who})`)
    for (const id of logged) revalidatePath(`/exportacoes/${id}`)
  } catch (e) {
    console.error('[email pdf: histórico do resumo]', e)
  }
}

export async function GET() {
  // a tela pergunta se o envio está configurado (sem expor nenhum dado da conta)
  const u = await routeUser()
  if (u instanceof Response) return u
  return Response.json({ ok: true, configured: mailConfigured(), maxBytes: MAX_BYTES })
}

export async function POST(req: Request) {
  const u = await routeUser()
  if (u instanceof Response) return u
  if (!mailConfigured())
    return Response.json({ ok: false, error: 'O envio de e-mail ainda não está configurado no servidor (conta SMTP da empresa). Peça ao administrador para preencher SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM.' }, { status: 503 })
  // corpo declarado acima do limite: recusa antes de ler (folga para os campos do formulário)
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES + 64 * 1024) return Response.json({ ok: false, error: TOO_BIG }, { status: 413 })
  // recusa barata antes de ler o corpo; o limite de verdade é a reserva atômica logo antes do envio
  if ((await sentLast24h(db, u.id)) >= DAILY_CAP) return Response.json({ ok: false, error: CAP_MSG }, { status: 429 })
  let fd: FormData
  try {
    fd = await req.formData()
  } catch {
    return Response.json({ ok: false, error: 'Não foi possível ler o anexo (envio incompleto ou grande demais). ' + TOO_BIG }, { status: 413 })
  }
  const to = list(fd.get('to'))
  const cc = list(fd.get('cc'))
  const subject = String(fd.get('subject') ?? '').trim().slice(0, 200)
  const message = String(fd.get('message') ?? '').slice(0, 5000)
  const file = fd.get('file')
  if (!to.length) return Response.json({ ok: false, error: 'Informe o e-mail do destinatário.' }, { status: 400 })
  if (to.length + cc.length > 10) return Response.json({ ok: false, error: 'No máximo 10 destinatários.' }, { status: 400 })
  const bad = [...to, ...cc].find((e) => !EMAIL.test(e))
  if (bad) return Response.json({ ok: false, error: `E-mail inválido: ${bad}` }, { status: 400 })
  if (!subject) return Response.json({ ok: false, error: 'Informe o assunto.' }, { status: 400 })
  if (!(file instanceof File) || file.type !== 'application/pdf' || file.size === 0) return Response.json({ ok: false, error: 'Anexo inválido (envie o PDF gerado na plataforma).' }, { status: 400 })
  if (file.size > MAX_BYTES) return Response.json({ ok: false, error: TOO_BIG }, { status: 413 })
  const content = Buffer.from(await file.arrayBuffer())
  // conteúdo de PDF de verdade (não só o tipo declarado pelo navegador)
  if (content.subarray(0, 5).toString('latin1') !== '%PDF-') return Response.json({ ok: false, error: 'Anexo inválido: o arquivo não é um PDF.' }, { status: 400 })
  // só um pedido válido gasta cota
  const slot = await reserveSend(u.id, { to, cc, subject, file: file.name, bytes: file.size })
  if (slot === null) return Response.json({ ok: false, error: CAP_MSG }, { status: 429 })

  try {
    await sendMail({
      to,
      cc: cc.length ? cc : undefined,
      replyTo: u.email,
      subject,
      text: message,
      attachments: [{ filename: file.name.replace(/[^\w.() -]+/g, '_') || 'documento.pdf', content, contentType: 'application/pdf' }],
    })
  } catch (e) {
    console.error('[email pdf]', e)
    await finishSend(slot, 'pdf_error', { error: e instanceof Error ? e.message : String(e) })
    return Response.json({ ok: false, error: 'O servidor de e-mail recusou o envio. Verifique os endereços ou a configuração SMTP.' }, { status: 502 })
  }
  await finishSend(slot, SENT)
  await logContext(fd.get('context'), u, to, cc)
  return Response.json({ ok: true })
}
