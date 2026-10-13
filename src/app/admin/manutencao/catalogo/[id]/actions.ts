'use server'

import { after } from 'next/server'
import { revalidatePath } from 'next/cache'
import { AuthError, assertUser } from '@/lib/auth'
import { applyCatalogImport, CatalogImportError } from '@/lib/catalogImport/apply'
import { discardCatalogImport } from '@/lib/catalogImport/preview'
import { syncCatalogImportCompositions } from '@/lib/catalogImport/sync'
import type { ApplyResult, SyncReport } from '@/domain/catalogImport/types'

export type ApplyActionResult = { ok: true; result: ApplyResult } | { ok: false; error: string }
export type SyncActionResult = { ok: true; report: SyncReport | null } | { ok: false; error: string }
export type SimpleResult = { ok: true } | { ok: false; error: string }

const validId = (id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0

function revalidateAll(id: number) {
  revalidatePath('/catalogo')
  revalidatePath('/precos-exportacao')
  revalidatePath('/admin/manutencao')
  revalidatePath(`/admin/manutencao/catalogo/${id}`)
}

function errorOf(e: unknown, what: string): string {
  if (e instanceof CatalogImportError || e instanceof AuthError) return e.message
  console.error(`[importação do catálogo] ${what}`, e)
  return `Erro inesperado ao ${what}. Nada foi gravado.`
}

/**
 * APLICA a prévia ao catálogo (uma transação). Depois da resposta, as montagens de palete são atualizadas
 * (archive das REF dos SKUs que saíram, geração das novas); a tela acompanha o status.
 */
export async function applyCatalogImportAction(id: number): Promise<ApplyActionResult> {
  try {
    const me = await assertUser('manageUsers')
    if (!validId(id)) return { ok: false, error: 'Importação inválida.' }
    const result = await applyCatalogImport(id, me.id)
    revalidateAll(id)
    after(async () => {
      try {
        await syncCatalogImportCompositions(id, me.id)
      } catch (e) {
        // fica SYNC_FAILED com a mensagem; a tela oferece "Atualizar de novo"
        console.error('[importação do catálogo] montagens de palete', e)
      }
    })
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: errorOf(e, 'aplicar a importação') }
  }
}

/** SIMULA a aplicação (mesma transação, desfeita no fim): mostra o que seria criado/desativado. */
export async function simulateCatalogImportAction(id: number): Promise<ApplyActionResult> {
  try {
    const me = await assertUser('manageUsers')
    if (!validId(id)) return { ok: false, error: 'Importação inválida.' }
    return { ok: true, result: await applyCatalogImport(id, me.id, { dryRun: true }) }
  } catch (e) {
    return { ok: false, error: errorOf(e, 'simular a importação') }
  }
}

/** Atualiza (de novo) as montagens de palete de uma importação aplicada. */
export async function syncCatalogImportAction(id: number): Promise<SyncActionResult> {
  try {
    const me = await assertUser('manageUsers')
    if (!validId(id)) return { ok: false, error: 'Importação inválida.' }
    const report = await syncCatalogImportCompositions(id, me.id)
    revalidatePath(`/admin/manutencao/catalogo/${id}`)
    return { ok: true, report }
  } catch (e) {
    revalidatePath(`/admin/manutencao/catalogo/${id}`)
    if (e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[importação do catálogo] montagens de palete', e)
    return { ok: false, error: `Falha ao atualizar as montagens de palete: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Descarta a prévia (não aplicada). */
export async function discardCatalogImportAction(id: number): Promise<SimpleResult> {
  try {
    const me = await assertUser('manageUsers')
    if (!validId(id)) return { ok: false, error: 'Importação inválida.' }
    if (!(await discardCatalogImport(id, me.id))) return { ok: false, error: 'Só uma prévia ainda não aplicada pode ser descartada.' }
    revalidatePath('/admin/manutencao')
    revalidatePath(`/admin/manutencao/catalogo/${id}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorOf(e, 'descartar a prévia') }
  }
}
