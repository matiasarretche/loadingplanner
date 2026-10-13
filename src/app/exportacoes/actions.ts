'use server'

import { revalidatePath } from 'next/cache'
import { isActiveStatus } from '@/domain/exportTracking'
import { canAccessPlan } from '@/lib/access'
import { logAudit } from '@/lib/audit'
import { assertUser, AuthError } from '@/lib/auth'
import { applyTrackingPatch, confirmOrder, operationContext, undoConfirmation } from '@/lib/exportTracking'
import { canSeeExports } from '@/lib/roles'
import type { ConfirmInput, TrackingPatch } from './types'

/**
 * EXPORTAÇÕES EM CURSO — Server Actions (respondem { ok, error } e a tela faz router.refresh()).
 * Permissão: papel (assertUser) + área Exportação sem Expedição (canSeeExports) + acesso à carga.
 * A gravação passa sempre por src/lib/exportTracking.ts (applyTrackingPatch: o mesmo caminho das integrações).
 */

const AREA_ERROR = 'Disponível só para usuários da área de Exportação.'

/** lista, detalhe das operações, painel de cargas e páginas das cargas afetadas */
function revalidate(opIds: number[], planIds: number[]) {
  revalidatePath('/exportacoes')
  for (const id of new Set(opIds)) revalidatePath(`/exportacoes/${id}`)
  revalidatePath('/')
  for (const id of new Set(planIds)) revalidatePath(`/cargas/${id}`)
}

function failure(e: unknown, what: string) {
  if (e instanceof AuthError) return { ok: false as const, error: e.message }
  console.error(`[exportações: ${what}]`, e)
  return { ok: false as const, error: `Não foi possível ${what}. Nada foi alterado.` }
}

/**
 * Confirma o pedido da carga (diálogo na página da carga): cria a operação de seguimento. Exige versão
 * APROVADA. includeSiblings: confirma junto as outras unidades do pedido aprovadas e ainda sem operação.
 * operationId = operação desta carga (→ /exportacoes/{operationId}); created = todas as criadas.
 */
export async function confirmOrderAction(planId: number, input: ConfirmInput): Promise<{ ok: true; operationId: number; created: number[] } | { ok: false; error: string }> {
  try {
    const me = await assertUser('confirmOrder')
    if (!canSeeExports(me)) return { ok: false, error: AREA_ERROR }
    if (!Number.isInteger(planId) || !(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const clean: ConfirmInput = {
      confirmedAt: String(input?.confirmedAt ?? '').trim(),
      paymentReceivedAt: input?.paymentReceivedAt ? String(input.paymentReceivedAt).trim() || null : null,
      includeSiblings: input?.includeSiblings === true,
    }
    const r = await confirmOrder([planId], clean, me)
    if (!r.ok) return r
    for (const [i, id] of r.created.entries())
      await logAudit('export_operation', id, 'confirm', me.id, { loadPlanId: r.planIds[i], confirmedAt: clean.confirmedAt || null, paymentReceivedAt: clean.paymentReceivedAt, fromPlanId: planId, includeSiblings: clean.includeSiblings })
    const ctx = await operationContext(r.created[0])
    revalidate([...r.created, ...(ctx?.siblings.map((s) => s.id) ?? [])], [...r.planIds, ...(ctx?.planIds ?? [])])
    return { ok: true, operationId: r.created[0], created: r.created }
  } catch (e) {
    return failure(e, 'confirmar o pedido')
  }
}

/**
 * Altera o seguimento (mande só os campos alterados ou a copiar). applyToSiblings: aplica também às outras
 * cargas do pedido que têm operação EM CURSO — exceto Nº do contêiner e lacre (por unidade). Finalizadas e
 * canceladas (Histórico) nunca são alteradas por aqui: só reabrem por uma mudança feita nelas mesmas.
 * updated = operações alteradas.
 */
export async function updateTrackingAction(operationId: number, patch: TrackingPatch, o: { applyToSiblings: boolean }): Promise<{ ok: true; updated: number[] } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editTracking')
    if (!canSeeExports(me)) return { ok: false, error: AREA_ERROR }
    const ctx = await operationContext(operationId)
    if (!ctx || !(await canAccessPlan(me, ctx.loadPlanId))) return { ok: false, error: 'Operação não encontrada.' }
    const ids = [ctx.id, ...(o?.applyToSiblings === true ? ctx.siblings.filter((s) => isActiveStatus(s.status)).map((s) => s.id) : [])]
    const r = await applyTrackingPatch(ids, patch, { userId: me.id, source: 'MANUAL' })
    if (!r.ok) return r
    if (r.updated.length) await logAudit('export_operation', ctx.id, 'update', me.id, { patch, applyToSiblings: o?.applyToSiblings === true, updated: r.updated })
    revalidate([ctx.id, ...ctx.siblings.map((s) => s.id)], ctx.planIds)
    return { ok: true, updated: r.updated }
  } catch (e) {
    return failure(e, 'salvar o seguimento')
  }
}

/**
 * "Desfazer confirmação": só enquanto o status é CONFIRMED. Exclui a operação e o histórico dela; a tela
 * deve voltar para a carga (/cargas/{loadPlanId}).
 */
export async function undoConfirmationAction(operationId: number): Promise<{ ok: true; loadPlanId: number } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editTracking')
    if (!canSeeExports(me)) return { ok: false, error: AREA_ERROR }
    const ctx = await operationContext(operationId)
    if (!ctx || !(await canAccessPlan(me, ctx.loadPlanId))) return { ok: false, error: 'Operação não encontrada.' }
    const r = await undoConfirmation(ctx.id, me)
    if (!r.ok) return r
    // a operação excluída inteira fica na auditoria (o histórico dela sai junto)
    await logAudit('export_operation', ctx.id, 'undo_confirm', me.id, { removed: r.removed })
    revalidate([ctx.id, ...ctx.siblings.map((s) => s.id)], ctx.planIds)
    return { ok: true, loadPlanId: r.loadPlanId }
  } catch (e) {
    return failure(e, 'desfazer a confirmação')
  }
}
