'use server'

import { and, eq, ne } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db, schema } from '@/db'
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
    if (isUniqueViolation(e)) {
      // cliente: o código do ERP é único — diz de qual cliente ele já é
      if (key === 'clientes' && typeof data.code === 'string') {
        const [other] = await db
          .select({ name: schema.customers.name })
          .from(schema.customers)
          .where(id == null ? eq(schema.customers.code, data.code) : and(eq(schema.customers.code, data.code), ne(schema.customers.id, id)))
          .limit(1)
        if (other) return { error: 'Corrija os campos destacados.', fieldErrors: { code: `O código ${data.code} já é do cliente “${other.name}”.` }, values }
      }
      // transportadora: o código do ERP é único — diz de qual (o nome se repete nas filiais)
      if (key === 'transportadoras' && typeof data.code === 'string') {
        const t = schema.transportCompanies
        const [other] = await db
          .select({ name: t.name })
          .from(t)
          .where(id == null ? eq(t.code, data.code) : and(eq(t.code, data.code), ne(t.id, id)))
          .limit(1)
        if (other) return { error: 'Corrija os campos destacados.', fieldErrors: { code: `O código ${data.code} já é da transportadora “${other.name}”.` }, values }
      }
      return { error: 'Já existe um registro com este código/nome.', values }
    }
    throw e
  }
  revalidatePath(`/cadastros/${key}`)
  redirect(`/cadastros/${key}?salvo=1`)
}
