import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import { transportCompanyLabel } from '@/domain/transportCompany'

/**
 * Transportadora escolhida numa tela (criar carga, pedido por IA, painel da carga) → id validado.
 * Sempre pelo ID (o seletor envia o id); nunca pelo NOME, que é ambíguo (filiais do ERP repetem o nome).
 * Compatibilidade: um texto antigo ("CÓDIGO — Nome" ou só o código) só vale se o CÓDIGO for exato.
 * Escolha nova precisa estar ATIVA; a já vinculada (`keepId`) pode continuar mesmo inativa.
 * Vazio → null (a definir).
 */
export async function resolveTransportCompany(
  id: number | string | null | undefined,
  o: { legacyText?: string | null; keepId?: number | null } = {},
): Promise<{ id: number | null } | { error: string }> {
  const raw = id == null ? '' : String(id).trim()
  let row: typeof schema.transportCompanies.$inferSelect | undefined
  if (raw) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) return { error: 'Transportadora inválida: escolha na lista.' }
    row = await db.query.transportCompanies.findFirst({ where: eq(schema.transportCompanies.id, n) })
    if (!row) return { error: 'Transportadora não encontrada: escolha na lista.' }
  } else {
    const text = o.legacyText?.trim()
    if (!text) return { id: null }
    const code = text.split(' — ')[0].trim()
    row = await db.query.transportCompanies.findFirst({ where: sql`lower(${schema.transportCompanies.code}) = ${code.toLowerCase()}` })
    if (!row) return { error: `Transportadora "${text}" não encontrada: escolha na lista pelo nome ou pelo código do ERP.` }
  }
  if (!row.active && row.id !== o.keepId) return { error: `A transportadora ${transportCompanyLabel(row)} está inativa: escolha outra.` }
  return { id: row.id }
}
