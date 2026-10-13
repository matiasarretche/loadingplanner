'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, assertUser } from '@/lib/auth'
import { type DeleteInput, type LoadCounts, validateDeleteInput } from '@/lib/maintenance/backupFormat'
import { deleteAllLoads, MaintenanceError } from '@/lib/maintenance/deleteAllLoads'

export type DeleteLoadsResult = { ok: true; counts: LoadCounts } | { ok: false; error: string }

/**
 * EXCLUIR TODAS AS CARGAS E PROFORMAS (só o administrador principal). Exige a palavra EXCLUIR, a
 * confirmação de que o backup foi guardado e o sha256 do backup baixado (conferido na auditoria).
 */
export async function deleteAllLoadsAction(input: DeleteInput): Promise<DeleteLoadsResult> {
  try {
    const me = await assertUser('manageUsers')
    const invalid = validateDeleteInput(input)
    if (invalid) return { ok: false, error: invalid }
    const counts = await deleteAllLoads(me.id, input.backupSha256)
    revalidatePath('/')
    revalidatePath('/exportacoes')
    revalidatePath('/admin/manutencao')
    return { ok: true, counts }
  } catch (e) {
    if (e instanceof MaintenanceError || e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[manutenção] excluir todas as cargas', e)
    return { ok: false, error: 'Erro inesperado ao excluir. Nada foi excluído.' }
  }
}
