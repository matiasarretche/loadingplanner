'use server'

import { z } from 'zod'
import { assertUser, AuthError } from '@/lib/auth'
import { OrderParseError, parseOrder, ParsedOrder } from '@/lib/ai/orderParser'
import { canAccessArea } from '@/lib/areas'
import { recordPlannerQuote } from '@/lib/loadPricing'

const input = z.string().trim().min(1, 'Escreva o pedido.').max(4000, 'Pedido longo demais (máx. 4.000 caracteres).')

export type ParseOrderResult = { ok: true; order: ParsedOrder } | { ok: false; error: string }

/** Pedido em linguagem natural → linhas do planejador de paletes mistos (a chave da IA nunca sai do servidor). */
export async function parseOrderAction(raw: unknown): Promise<ParseOrderResult> {
  try {
    const user = await assertUser('editPlans')
    const parsed = input.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Texto inválido.' }
    return { ok: true, order: await parseOrder(user, parsed.data) }
  } catch (e) {
    if (e instanceof AuthError || e instanceof OrderParseError) return { ok: false, error: e.message }
    console.error('[pedido IA]', e)
    return { ok: false, error: 'Erro inesperado no assistente.' }
  }
}

const quoteInput = z.object({
  origin: z.enum(['mixed', 'courier']),
  reference: z.string().trim().max(120).nullable(),
  destination: z.string().trim().max(80),
  agentId: z.number().int().positive().nullable(),
  incoterm: z.string().trim().max(10).nullable(),
  lang: z.enum(['pt', 'es', 'en']),
  lines: z.array(z.object({ sku: z.string().max(80), units: z.number().finite().nonnegative() })).max(400),
})

/**
 * Cotação emitida de paletes mistos/courier (PDF com preço gerado no navegador): o servidor RECALCULA
 * os preços com as mesmas regras e registra em Cotações emitidas. Só área de Exportação.
 */
export async function recordPlannerQuoteAction(raw: unknown): Promise<{ ok: true; id: number | null } | { ok: false; error: string }> {
  try {
    const user = await assertUser('editPlans')
    if (!canAccessArea(user, 'EXPORT')) return { ok: false, error: 'Só área de Exportação.' }
    const parsed = quoteInput.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Dados inválidos.' }
    const d = parsed.data
    const id = await recordPlannerQuote({ ...d, reference: d.reference || null, userId: user.id })
    return { ok: true, id }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[cotação paletes mistos]', e)
    return { ok: false, error: 'Não foi possível registrar a cotação.' }
  }
}
