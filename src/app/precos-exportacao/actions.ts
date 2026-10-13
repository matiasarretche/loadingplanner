'use server'

import { and, eq } from 'drizzle-orm'
import { refreezeCommission } from '@/lib/loadPricing'
import { revalidatePath } from 'next/cache'
import { db, schema } from '@/db'
import type { PriceMethod } from '@/domain/exportPricing'
import { canAccessArea } from '@/lib/areas'
import { assertUser, AuthError } from '@/lib/auth'

type Res = { ok: true } | { ok: false; error: string }
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const PATH = '/precos-exportacao'
const METHODS: PriceMethod[] = ['PER_KG', 'PER_KG_PLUS_FIXED', 'INCLUDED', 'RELATIVE']

/** Só gerente/administrador da área de Exportação edita preços. */
async function editor() {
  const me = await assertUser('editCatalog')
  if (!canAccessArea(me, 'EXPORT')) throw new AuthError('Preços de exportação: só usuários da área de Exportação.')
  return me
}

const str = (v: unknown) => (v == null ? null : String(v))

/** Registra no histórico cada campo que mudou (valor anterior → novo, quando e quem). */
async function history(tx: Tx, userId: number, base: { kind: string; familyId?: number | null; categoryId?: number | null; countryCode?: string | null }, changes: [string, unknown, unknown][]) {
  const rows = changes.filter(([, a, b]) => str(a) !== str(b)).map(([field, a, b]) => ({ ...base, field, oldValue: str(a), newValue: str(b), userId }))
  if (rows.length) await tx.insert(schema.priceHistory).values(rows)
  return rows.length
}

/** Valor em USD: vazio = sem valor; senão número ≥ 0 com até 4 casas. */
function money(v: string | number | null | undefined, label: string): number | null {
  if (v == null || String(v).trim() === '') return null
  const n = Number(String(v).replace(',', '.'))
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`${label}: valor inválido.`)
  return Math.round(n * 10000) / 10000
}

async function run(fn: () => Promise<void>): Promise<Res> {
  try {
    await fn()
    revalidatePath(PATH)
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError || e instanceof Error) return { ok: false, error: e.message }
    throw e
  }
}

/** Cria ou altera uma categoria comercial (código, nome, ordem, ativa). */
export async function saveCategoryAction(input: { id?: number; code: string; name: string; sort: number; active: boolean }): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const code = input.code.trim().toUpperCase()
    const name = input.name.trim()
    if (!code || !name) throw new Error('Informe código e nome da categoria.')
    await db.transaction(async (tx) => {
      const dup = await tx.query.priceCategories.findFirst({ where: eq(schema.priceCategories.code, code) })
      if (dup && dup.id !== input.id) throw new Error(`Já existe a categoria ${code}.`)
      if (input.id) {
        const cur = await tx.query.priceCategories.findFirst({ where: eq(schema.priceCategories.id, input.id) })
        if (!cur) throw new Error('Categoria não encontrada.')
        await tx.update(schema.priceCategories).set({ code, name, sort: input.sort, active: input.active, updatedAt: new Date(), updatedBy: me.id }).where(eq(schema.priceCategories.id, cur.id))
        await history(tx, me.id, { kind: 'category', categoryId: cur.id }, [
          ['code', cur.code, code],
          ['name', cur.name, name],
          ['sort', cur.sort, input.sort],
          ['active', cur.active, input.active],
        ])
      } else {
        const [c] = await tx.insert(schema.priceCategories).values({ code, name, sort: input.sort, active: true, createdBy: me.id, updatedBy: me.id }).returning()
        await history(tx, me.id, { kind: 'category', categoryId: c.id }, [['created', null, `${code} · ${name}`]])
      }
    })
  })
}

/** País (ISO-2) → categoria; null = tira o país de qualquer categoria (fica sem preço). */
export async function setCountryCategoryAction(countryCode: string, categoryId: number | null): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const cc = countryCode.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error('País inválido.')
    await db.transaction(async (tx) => {
      const cur = await tx.query.countryPriceCategories.findFirst({ where: eq(schema.countryPriceCategories.countryCode, cc) })
      if ((cur?.categoryId ?? null) === categoryId) return
      if (categoryId == null) await tx.delete(schema.countryPriceCategories).where(eq(schema.countryPriceCategories.countryCode, cc))
      else if (cur) await tx.update(schema.countryPriceCategories).set({ categoryId, updatedAt: new Date(), updatedBy: me.id }).where(eq(schema.countryPriceCategories.countryCode, cc))
      else await tx.insert(schema.countryPriceCategories).values({ countryCode: cc, categoryId, updatedBy: me.id })
      await history(tx, me.id, { kind: 'country_category', countryCode: cc, categoryId }, [['categoryId', cur?.categoryId ?? null, categoryId]])
    })
  })
}

/** Regra de preço da família (RELATIVE: família de referência + acréscimo %). */
export async function setFamilyMethodAction(familyId: number, method: PriceMethod, rel?: { refFamilyId: number | null; markupPct: string }): Promise<Res> {
  return run(async () => {
    const me = await editor()
    if (!METHODS.includes(method)) throw new Error('Regra inválida.')
    const refFamilyId = method === 'RELATIVE' ? rel?.refFamilyId ?? null : null
    const markupPct = method === 'RELATIVE' ? money(rel?.markupPct, 'Acréscimo %') : null
    if (method === 'RELATIVE' && refFamilyId === familyId) throw new Error('A família de referência não pode ser a própria família.')
    await db.transaction(async (tx) => {
      const cur = await tx.query.familyPriceRules.findFirst({ where: eq(schema.familyPriceRules.familyId, familyId) })
      const before = { method: cur?.method ?? 'PER_KG', refFamilyId: cur?.refFamilyId ?? null, markupPct: cur?.markupPct ?? null }
      if (before.method === method && before.refFamilyId === refFamilyId && before.markupPct === markupPct) return
      const set = { method, refFamilyId, markupPct, updatedAt: new Date(), updatedBy: me.id }
      if (cur) await tx.update(schema.familyPriceRules).set(set).where(eq(schema.familyPriceRules.familyId, familyId))
      else await tx.insert(schema.familyPriceRules).values({ familyId, ...set })
      await history(tx, me.id, { kind: 'family_rule', familyId }, [
        ['method', before.method, method],
        ['refFamilyId', before.refFamilyId, refFamilyId],
        ['markupPct', before.markupPct, markupPct],
      ])
    })
  })
}

/** Ajuste % da marca sobre o preço de lista (vazio ou 0 = sem ajuste; negativo = desconto). */
export async function setBrandAdjustAction(brand: string, pct: string): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const b = brand.trim()
    if (!b) throw new Error('Marca inválida.')
    const t = String(pct ?? '').trim().replace(',', '.')
    const v = t === '' ? 0 : Number(t)
    if (!Number.isFinite(v) || v < -50 || v > 50) throw new Error('Ajuste da marca: use um % entre −50 e 50.')
    await db.transaction(async (tx) => {
      const cur = await tx.query.brandPriceAdjustments.findFirst({ where: eq(schema.brandPriceAdjustments.brand, b) })
      if ((cur?.pct ?? 0) === v) return
      if (v === 0) await tx.delete(schema.brandPriceAdjustments).where(eq(schema.brandPriceAdjustments.brand, b))
      else if (cur) await tx.update(schema.brandPriceAdjustments).set({ pct: v, updatedAt: new Date(), updatedBy: me.id }).where(eq(schema.brandPriceAdjustments.brand, b))
      else await tx.insert(schema.brandPriceAdjustments).values({ brand: b, pct: v, updatedBy: me.id })
      await history(tx, me.id, { kind: 'brand_adjust', countryCode: null }, [[`brand:${b}`, cur?.pct ?? 0, v]])
    })
  })
}

/** % de comissão do agente para a família (perfil do agente). Vazio = remove (sem comissão definida). */
export async function setCommissionAction(agentId: number, familyId: number, pct: string): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const t = String(pct ?? '').trim().replace(',', '.')
    const v = t === '' ? null : Number(t)
    if (v != null && (!Number.isFinite(v) || v < 0 || v >= 50)) throw new Error('Comissão: use um % entre 0 e 50.')
    await db.transaction(async (tx) => {
      const where = and(eq(schema.commissionRates.agentId, agentId), eq(schema.commissionRates.familyId, familyId))
      const [cur] = await tx.select().from(schema.commissionRates).where(where)
      if ((cur?.pct ?? null) === v) return
      if (v == null) await tx.delete(schema.commissionRates).where(where)
      else if (cur) await tx.update(schema.commissionRates).set({ pct: v, updatedAt: new Date(), updatedBy: me.id }).where(where)
      else await tx.insert(schema.commissionRates).values({ agentId, familyId, pct: v, updatedBy: me.id })
      await history(tx, me.id, { kind: 'commission', familyId }, [[`commission:${agentId}`, cur?.pct ?? null, v]])
    })
    // % de comissão mudou: cargas APROVADAS com este agente são re-congeladas com o % novo
    const plans = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.agentId, agentId))
    await refreezeCommission(plans.map((p) => p.id))
  })
}

/**
 * Recargo CIF da família (USD/kg líquido; não há padrão geral). Vazio = sem recargo definido: a família
 * fica sem preço em cotações CIF (os outros Incoterms não mudam).
 */
export async function setFamilyCifAction(familyId: number, value: string): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const v = money(value, 'Recargo CIF')
    await db.transaction(async (tx) => {
      const cur = await tx.query.familyPriceRules.findFirst({ where: eq(schema.familyPriceRules.familyId, familyId) })
      if ((cur?.cifUsdPerKg ?? null) === v) return
      if (cur) await tx.update(schema.familyPriceRules).set({ cifUsdPerKg: v, updatedAt: new Date(), updatedBy: me.id }).where(eq(schema.familyPriceRules.familyId, familyId))
      else await tx.insert(schema.familyPriceRules).values({ familyId, method: 'PER_KG', cifUsdPerKg: v, updatedBy: me.id })
      await history(tx, me.id, { kind: 'cif', familyId }, [['cifUsdPerKg', cur?.cifUsdPerKg ?? null, v]])
    })
  })
}

/**
 * Família com faixas de diâmetro (Silo-bolsa): USD/kg de cada faixa numa categoria (vazio = sem valor;
 * o produto daquela faixa fica sem preço). Cada faixa alterada vai para o histórico.
 */
export async function setFamilyBandPricesAction(familyId: number, categoryId: number, values: Record<string, string>): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const bands = await db.select().from(schema.familyPriceBands).where(eq(schema.familyPriceBands.familyId, familyId))
    if (!bands.length) throw new Error('Esta família não tem faixas de diâmetro.')
    const parsed = bands.filter((b) => b.key in values).map((b) => ({ b, kg: money(values[b.key], `USD/kg ${b.label}`) }))
    await db.transaction(async (tx) => {
      for (const { b, kg } of parsed) {
        const where = and(eq(schema.familyBandPrices.familyId, familyId), eq(schema.familyBandPrices.categoryId, categoryId), eq(schema.familyBandPrices.bandKey, b.key))
        const [cur] = await tx.select().from(schema.familyBandPrices).where(where)
        if ((cur?.usdPerKg ?? null) === kg) continue
        if (cur) await tx.update(schema.familyBandPrices).set({ usdPerKg: kg, updatedAt: new Date(), updatedBy: me.id }).where(where)
        else await tx.insert(schema.familyBandPrices).values({ familyId, categoryId, bandKey: b.key, usdPerKg: kg, updatedBy: me.id })
        await history(tx, me.id, { kind: 'family_price', familyId, categoryId }, [[`usdPerKg:${b.key}`, cur?.usdPerKg ?? null, kg]])
      }
    })
  })
}

/** Preço da família numa categoria: USD/kg líquido e valor fixo USD/unidade (vazio = sem valor). */
export async function setFamilyPriceAction(familyId: number, categoryId: number, usdPerKg: string, fixedUsdPerUnit: string): Promise<Res> {
  return run(async () => {
    const me = await editor()
    const kg = money(usdPerKg, 'USD/kg')
    const fixed = money(fixedUsdPerUnit, 'Valor fixo por unidade')
    await db.transaction(async (tx) => {
      const where = and(eq(schema.familyPrices.familyId, familyId), eq(schema.familyPrices.categoryId, categoryId))
      const [cur] = await tx.select().from(schema.familyPrices).where(where)
      if (cur && cur.usdPerKg === kg && cur.fixedUsdPerUnit === fixed) return
      if (!cur && kg == null && fixed == null) return
      if (cur) await tx.update(schema.familyPrices).set({ usdPerKg: kg, fixedUsdPerUnit: fixed, updatedAt: new Date(), updatedBy: me.id }).where(where)
      else await tx.insert(schema.familyPrices).values({ familyId, categoryId, usdPerKg: kg, fixedUsdPerUnit: fixed, updatedBy: me.id })
      await history(tx, me.id, { kind: 'family_price', familyId, categoryId }, [
        ['usdPerKg', cur?.usdPerKg ?? null, kg],
        ['fixedUsdPerUnit', cur?.fixedUsdPerUnit ?? null, fixed],
      ])
    })
  })
}
