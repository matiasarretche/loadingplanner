'use server'

import { z } from 'zod'
import { loadDocSchema } from '@/domain/schemas'
import type { LoadDoc } from '@/domain/types'
import { assertUser, AuthError } from '@/lib/auth'
import { AssistantError, AssistantReply, askAssistant } from '@/lib/ai/service'
import { canAccessVersion } from '@/lib/access'

const input = z.object({
  conversationId: z.number().int().positive().nullable(),
  versionId: z.number().int().positive(),
  message: z.string().trim().min(1, 'Escreva uma instrução.').max(2000, 'Instrução longa demais (máx. 2.000 caracteres).'),
  baseDoc: loadDocSchema,
})

export type AssistantActionResult = { ok: true; reply: AssistantReply } | { ok: false; error: string }

/** Entrada do Assistente IA: sessão + permissão + validação server-side; a chave da IA nunca sai do servidor. */
export async function askAssistantAction(raw: unknown): Promise<AssistantActionResult> {
  try {
    const user = await assertUser('editPlans')
    const parsed = input.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
    if (!(await canAccessVersion(user, parsed.data.versionId))) return { ok: false, error: 'Carga não encontrada.' }
    const reply = await askAssistant(user, {
      conversationId: parsed.data.conversationId,
      loadPlanVersionId: parsed.data.versionId,
      message: parsed.data.message,
      baseDoc: parsed.data.baseDoc as LoadDoc,
    })
    return { ok: true, reply }
  } catch (e) {
    if (e instanceof AuthError || e instanceof AssistantError) return { ok: false, error: e.message }
    console.error('[assistente]', e)
    return { ok: false, error: 'Erro inesperado no assistente.' }
  }
}
