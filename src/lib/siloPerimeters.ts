/**
 * PERÍMETRO REAL DO SILO-BOLSA (Matías, 14/10/2026): grava a tabela de perímetros da família e recalcula o peso
 * das embalagens vigentes de TODOS os silo-bolsas ativos (todas as marcas e linhas) cujo diâmetro tem perímetro real:
 *
 *     líquido         = perímetro real × comprimento × espessura × 0,932 (src/domain/siloPerimeter.ts)
 *     c/ embalagem    = líquido novo + tara da caixa (c/ embalagem − líquido atuais)
 *
 * Peso diferente → SEMPRE nova versão da embalagem (encerra a vigente hoje e cria v(n+1)): as cargas salvas
 * guardam a cópia da época e o histórico mostra o peso antigo. Diâmetro sem perímetro real → não mexe.
 */
// Sem 'server-only': também é usado por scripts de linha de comando (simulação no banco local).
// A revalidação das telas fica na server action (fora do Next não existe cache para revalidar).
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { todayBR } from '@/domain/exportTracking'
import { productKind } from '@/domain/productOrder'
import {
  calcLengthM,
  decideRecalc,
  diameterKey,
  PERIMETER_FACTOR_RANGE,
  perimeterRowError,
  roundPerimeterM,
  siloBagFormulaText,
  type RecalcDecision,
  type RecalcPack,
  type RecalcVariant,
  type SiloPerimeter,
} from '@/domain/siloPerimeter'

export interface PerimeterRowInput {
  diameterFt: number
  perimeterM: number
}

export interface PerimeterRecalcChange {
  sku: string
  name: string
  brand: string
  diameterFt: number
  fromNetKg: number
  toNetKg: number
  fromGrossKg: number
  toGrossKg: number
  newVersion: number
}

export interface PerimeterRecalcSkip {
  sku: string
  name: string
  reason: string
}

export interface PerimeterRecalcResult {
  dryRun: boolean
  perimeters: { diameterFt: number; perimeterM: number }[]
  changed: PerimeterRecalcChange[]
  unchanged: number
  skipped: PerimeterRecalcSkip[]
}

/** Erro com mensagem pronta para o usuário (pt-BR). */
export class SiloPerimeterError extends Error {}

/** sentinela para desfazer a transação da simulação (dryRun) levando o resultado junto */
class Rollback extends Error {
  constructor(readonly result: PerimeterRecalcResult) {
    super('rollback')
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type PvRow = typeof s.packagingVersions.$inferSelect
type PvInsert = typeof s.packagingVersions.$inferInsert

const r2 = (x: number) => Math.round(x * 100) / 100
const CHUNK = 100
/** máximo de SKUs listados na auditoria do recálculo (o total vai junto) */
const AUDIT_MAX_SKUS = 300

const fmt = (x: number, min = 0, max = 3) => x.toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })
const kgTxt = (x: number) => `${fmt(x, 2, 3)} kg`

/** família do silo-bolsa? (código SILO_BAG ou nome reconhecido como silo-bolsa) */
export const isSiloBagFamily = (f: { code: string; name: string }) => f.code === 'SILO_BAG' || productKind(f.name) === 'silo'

/**
 * Tabela pronta para gravar: diâmetro com 2 casas e perímetro com 3 (as casas do banco — o cálculo usa o valor
 * gravado; a validação também, como a tela), ordenada pelo diâmetro. Linha inválida ou diâmetro repetido → SiloPerimeterError.
 */
export function normalizePerimeterRows(rows: readonly PerimeterRowInput[]): SiloPerimeter[] {
  const seen = new Set<string>()
  const out: SiloPerimeter[] = []
  for (const r of rows) {
    const perimeterM = roundPerimeterM(r.perimeterM)
    const err = perimeterRowError(r.diameterFt, perimeterM)
    if (err) throw new SiloPerimeterError(`${fmt(r.diameterFt, 0, 2)} pés: ${err}`)
    const diameterFt = r2(r.diameterFt)
    const key = diameterKey(diameterFt)
    if (seen.has(key)) throw new SiloPerimeterError(`Diâmetro ${fmt(diameterFt, 0, 2)} pés repetido na tabela.`)
    seen.add(key)
    out.push({ diameterFt, perimeterM })
  }
  return out.sort((a, b) => a.diameterFt - b.diameterFt)
}

// regras puras em src/domain/siloPerimeter.ts (a tela usa as mesmas); reexportadas para o servidor e os testes
export { decideRecalc, PERIMETER_FACTOR_RANGE, perimeterRowError, roundPerimeterM, type RecalcDecision, type RecalcPack, type RecalcVariant }

/** linha das observações da nova versão da embalagem */
export function recalcNote(d: { perimeterM: number; lengthM: number; thicknessUm: number; netKg: number }, fromNetKg: number): string {
  return `Peso líquido pelo perímetro real: ${siloBagFormulaText(d)} = ${kgTxt(d.netKg)} (antes ${kgTxt(fromNetKg)})`
}

/** tabela de perímetros da família (ordenada pelo diâmetro) */
export async function loadFamilyPerimeters(q: Tx | typeof db, familyId: number): Promise<SiloPerimeter[]> {
  return q
    .select({ diameterFt: s.familyPerimeters.diameterFt, perimeterM: s.familyPerimeters.perimeterM })
    .from(s.familyPerimeters)
    .where(eq(s.familyPerimeters.familyId, familyId))
    .orderBy(asc(s.familyPerimeters.diameterFt))
}

/**
 * Para a edição manual do catálogo: lê a tabela da família DENTRO da transação, esperando um recálculo ou uma
 * importação do catálogo em andamento terminar (e segurando a tabela até o fim desta transação). Chamar ANTES de
 * gravar o produto. As três rotas que gravam peso de silo-bolsa travam na MESMA ordem — perímetros → produtos →
 * embalagens: esta edição (family_perimeter e depois as gravações), o recálculo (abaixo) e a importação do catálogo
 * (LOCK TABLE family_perimeter, product_family, product, product_variant, packaging_version, pallet_type — os
 * perímetros PRIMEIRO). Por isso não há impasse (deadlock) entre elas: quem chega depois espera sem segurar nada.
 */
export async function lockedFamilyPerimeters(tx: Tx, familyId: number): Promise<SiloPerimeter[]> {
  await tx.execute(sql`LOCK TABLE family_perimeter IN SHARE MODE`)
  return loadFamilyPerimeters(tx, familyId)
}

/**
 * GRAVA a tabela de perímetros reais da família silo-bolsa e RECALCULA o peso das embalagens, numa transação só:
 *  1. confere a família (silo-bolsa) e trava perímetros, produtos e embalagens, nessa ordem (espera a importação do
 *     catálogo e as edições em andamento; elas esperam esta);
 *  2. substitui a tabela da família por `rows` (as ausentes saem);
 *  3. para cada produto ATIVO da família com perímetro real no diâmetro: calcula o líquido; diferente do cadastrado
 *     → nova versão da embalagem (líquido calculado, c/ embalagem = calculado + tara atual, observação com a fórmula);
 *     sem embalagem / sem medidas / várias unidades por caixa / sem peso líquido ou c/ embalagem / tara negativa
 *     → listado em `skipped` (motivos de packRecalcBlocker, os mesmos da tela);
 *  4. attrs.perimetro_m dos produtos com perímetro real = o da tabela (a ficha do produto mostra o mesmo valor);
 *  5. auditoria (tabela e lista de SKUs recalculados).
 * `dryRun`: faz tudo e desfaz no fim (prévia), devolvendo o mesmo resultado.
 * As montagens de palete são atualizadas depois, fora desta transação (server action).
 */
export async function applySiloBagPerimeters(o: { familyId: number; rows: PerimeterRowInput[]; userId: number; dryRun?: boolean }): Promise<PerimeterRecalcResult> {
  const dryRun = Boolean(o.dryRun)
  const table = normalizePerimeterRows(o.rows)
  try {
    return await db.transaction(async (tx) => {
      const [fam] = await tx.select().from(s.productFamilies).where(eq(s.productFamilies.id, o.familyId))
      if (!fam) throw new SiloPerimeterError('Família não encontrada.')
      if (!isSiloBagFamily(fam)) throw new SiloPerimeterError(`O perímetro real só vale para a família Silo-bolsa (esta é ${fam.name}).`)

      // ordem das travas: perímetros → produtos → embalagens, a mesma das outras duas rotas — a importação do
      // catálogo também trava family_perimeter PRIMEIRO (depois product_family → product → product_variant →
      // packaging_version → pallet_type) e a edição manual de silo-bolsa trava perímetros antes de gravar o
      // produto (lockedFamilyPerimeters) — sem impasse entre as três
      await tx.execute(sql`LOCK TABLE family_perimeter, product_variant, packaging_version IN SHARE ROW EXCLUSIVE MODE`)
      const now = new Date()
      const today = todayBR(now)

      // ---- tabela da família: atualiza as que mudaram, cria as novas e apaga as que saíram
      const before = await tx.select().from(s.familyPerimeters).where(eq(s.familyPerimeters.familyId, o.familyId)).orderBy(asc(s.familyPerimeters.diameterFt))
      const wanted = new Map(table.map((r) => [diameterKey(r.diameterFt), r]))
      const removed = before.filter((b) => !wanted.has(diameterKey(b.diameterFt))).map((b) => b.id)
      if (removed.length) await tx.delete(s.familyPerimeters).where(inArray(s.familyPerimeters.id, removed))
      for (const r of table) {
        const cur = before.find((b) => diameterKey(b.diameterFt) === diameterKey(r.diameterFt))
        if (!cur) await tx.insert(s.familyPerimeters).values({ familyId: o.familyId, diameterFt: r.diameterFt, perimeterM: r.perimeterM, updatedAt: now, updatedBy: o.userId })
        else if (roundPerimeterM(cur.perimeterM) !== r.perimeterM)
          await tx.update(s.familyPerimeters).set({ perimeterM: r.perimeterM, updatedAt: now, updatedBy: o.userId }).where(eq(s.familyPerimeters.id, cur.id))
      }
      const beforeTable = before.map((b) => ({ diameterFt: b.diameterFt, perimeterM: roundPerimeterM(b.perimeterM) }))
      if (JSON.stringify(beforeTable) !== JSON.stringify(table)) {
        await tx.insert(s.auditLog).values({ entity: 'family_perimeter', entityId: o.familyId, action: 'update', userId: o.userId, diff: { perimetros: { de: beforeTable, para: table } } })
      }

      // ---- produtos ativos da família (todas as marcas e linhas) com a embalagem vigente (maior versão)
      const variants = await tx
        .select({
          id: s.productVariants.id,
          sku: s.productVariants.sku,
          name: s.productVariants.name,
          brand: s.productVariants.brand,
          diameterFt: s.productVariants.diameterFt,
          lengthM: s.productVariants.lengthM,
          lengthFt: s.productVariants.lengthFt,
          thicknessUm: s.productVariants.thicknessUm,
          attrs: s.productVariants.attrs,
        })
        .from(s.productVariants)
        .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
        .where(and(eq(s.products.familyId, o.familyId), eq(s.products.active, true), eq(s.productVariants.active, true)))
      variants.sort(
        (a, b) =>
          (a.diameterFt ?? Infinity) - (b.diameterFt ?? Infinity) ||
          (calcLengthM(a) ?? Infinity) - (calcLengthM(b) ?? Infinity) ||
          (a.thicknessUm ?? Infinity) - (b.thicknessUm ?? Infinity) ||
          a.sku.localeCompare(b.sku, 'pt-BR', { numeric: true }),
      )
      const ids = variants.map((v) => v.id)
      const packs = new Map<number, PvRow>()
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await tx
          .selectDistinctOn([s.packagingVersions.variantId])
          .from(s.packagingVersions)
          .where(inArray(s.packagingVersions.variantId, ids.slice(i, i + CHUNK)))
          .orderBy(s.packagingVersions.variantId, desc(s.packagingVersions.version))
        for (const r of rows) packs.set(r.variantId, r)
      }

      const result: PerimeterRecalcResult = { dryRun, perimeters: table.map((r) => ({ ...r })), changed: [], unchanged: 0, skipped: [] }
      const closeIds: number[] = []
      const inserts: PvInsert[] = []
      const attrIdsByPerimeter = new Map<number, number[]>()
      for (const v of variants) {
        const cur = packs.get(v.id) ?? null
        const d = decideRecalc(table, v, cur)
        if (d.kind === 'none') continue
        // ficha do produto: o perímetro mostrado passa a ser o real (mesmo sem recalcular o peso)
        if (v.attrs?.perimetro_m !== d.perimeterM) attrIdsByPerimeter.set(d.perimeterM, [...(attrIdsByPerimeter.get(d.perimeterM) ?? []), v.id])
        if (d.kind === 'skip') {
          result.skipped.push({ sku: v.sku, name: v.name, reason: d.reason })
          continue
        }
        if (d.kind === 'same' || !cur) {
          result.unchanged++
          continue
        }
        // nova versão: encerra a vigente hoje e cria v(n+1) com o peso calculado (caixa, palete e verificação copiados)
        closeIds.push(cur.id)
        const copy: Partial<PvRow> = { ...cur }
        for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo', 'createdBy', 'updatedBy'] as const) delete copy[k]
        const note = recalcNote(d, cur.netKg)
        inserts.push({
          ...(copy as PvInsert),
          variantId: v.id,
          version: cur.version + 1,
          netKg: d.netKg,
          grossKg: d.grossKg,
          validFrom: today,
          validTo: null,
          locked: false,
          notes: cur.notes?.trim() ? `${cur.notes.trim()}\n${note}` : note,
          createdBy: o.userId,
          updatedBy: o.userId,
        })
        result.changed.push({
          sku: v.sku,
          name: v.name,
          brand: v.brand,
          diameterFt: v.diameterFt!,
          fromNetKg: cur.netKg,
          toNetKg: d.netKg,
          fromGrossKg: cur.grossKg,
          toGrossKg: d.grossKg,
          newVersion: cur.version + 1,
        })
      }

      for (let i = 0; i < closeIds.length; i += CHUNK) {
        await tx
          .update(s.packagingVersions)
          .set({ validTo: today, updatedAt: now, updatedBy: o.userId })
          .where(and(inArray(s.packagingVersions.id, closeIds.slice(i, i + CHUNK)), isNull(s.packagingVersions.validTo)))
      }
      for (let i = 0; i < inserts.length; i += CHUNK) await tx.insert(s.packagingVersions).values(inserts.slice(i, i + CHUNK))
      for (const [perimeterM, vids] of attrIdsByPerimeter) {
        await tx
          .update(s.productVariants)
          .set({ attrs: sql`${s.productVariants.attrs} || jsonb_build_object('perimetro_m', ${perimeterM}::numeric)`, updatedAt: now, updatedBy: o.userId })
          .where(inArray(s.productVariants.id, vids))
      }

      if (result.changed.length) {
        await tx.insert(s.auditLog).values({
          entity: 'packaging_version',
          entityId: null,
          action: 'perimeter_recalc',
          userId: o.userId,
          diff: {
            familyId: o.familyId,
            perimetros: table,
            total: result.changed.length,
            produtos: result.changed.slice(0, AUDIT_MAX_SKUS).map((c) => ({ sku: c.sku, versao: c.newVersion, liquido: { de: c.fromNetKg, para: c.toNetKg }, bruto: { de: c.fromGrossKg, para: c.toGrossKg } })),
            ...(result.changed.length > AUDIT_MAX_SKUS ? { omitidos: result.changed.length - AUDIT_MAX_SKUS } : {}),
            semRecalculo: result.skipped.length,
          },
        })
      }

      if (dryRun) throw new Rollback(result)
      return result
    })
  } catch (e) {
    if (e instanceof Rollback) return e.result
    throw e
  }
}
