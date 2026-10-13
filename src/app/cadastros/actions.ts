'use server'

import { eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { assertUser } from '@/lib/auth'
import { diffRecords, logAudit } from '@/lib/audit'
import { isUniqueViolation } from '@/lib/dbErrors'
import { refreshPalletSnapshots } from '@/lib/refreshPalletSnapshots'
import { isResourceKey, parseFields, RESOURCES } from '@/lib/resources'

export interface ResourceFormState {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
}

export async function saveResourceAction(key: string, id: number | null, _: ResourceFormState, fd: FormData): Promise<ResourceFormState> {
  const me = await assertUser('editCatalog')
  if (!isResourceKey(key)) return { error: 'Cadastro inválido.' }
  const r = RESOURCES[key]
  const values = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))
  const { data, errors } = parseFields(r.fields, fd)
  if (Object.keys(errors).length) return { error: 'Corrija os campos destacados.', fieldErrors: errors, values }

  const table = r.table as unknown as PgTable & { id: PgColumn }
  try {
    if (id == null) {
      const [row] = await db
        .insert(table)
        .values({ ...data, createdBy: me.id, updatedBy: me.id } as never)
        .returning({ id: table.id })
      await logAudit(key, (row as { id: number }).id, 'create', me.id, data)
    } else {
      const [before] = await db.select().from(table).where(eq(table.id, id))
      if (!before) return { error: 'Registro não encontrado.' }
      await db
        .update(table)
        .set({ ...data, updatedBy: me.id, updatedAt: new Date() } as never)
        .where(eq(table.id, id))
      await logAudit(key, id, 'update', me.id, diffRecords(before as Record<string, unknown>, data))
      // montagens (modelos) passam a usar os dados novos do palete; cargas salvas mantêm o snapshot
      if (key === 'paletes') {
        const r = await refreshPalletSnapshots([id])
        if (r.updated) await logAudit('pallet_composition', null, 'refresh_pallet_snapshot', me.id, { palletTypeId: id, montagens: r.updated })
      }
    }
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'Já existe um registro com este código/nome.', values }
    throw e
  }
  revalidatePath(`/cadastros/${key}`)
  redirect(`/cadastros/${key}?salvo=1`)
}
