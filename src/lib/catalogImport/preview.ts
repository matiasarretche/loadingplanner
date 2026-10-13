// Sem 'server-only': também é usado pelo script de linha de comando (scripts/catalog-import-dry-run.ts).
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { buildImportPlan } from '@/domain/catalogImport'
import type { ImportPlan, PlanWarning, Summary } from '@/domain/catalogImport/types'
import { catalogFingerprint, loadCurrentCatalog } from './currentCatalog'
import { readBoxesXlsx, readProductsXlsx } from './readSheets'

export interface UploadedSheet {
  name: string
  buf: Buffer
}

/**
 * Lê as duas planilhas e monta o plano (nada é gravado no catálogo). Usado pela prévia (rota) e pelo
 * script de simulação. Os avisos do servidor (regras de preço das famílias) entram no fim da lista.
 */
export async function buildPlanFromSheets(files: { products: UploadedSheet; boxes: UploadedSheet }): Promise<ImportPlan> {
  // a tabela de caixas é pequena: valida primeiro (erro rápido se trocaram os arquivos)
  const boxes = await readBoxesXlsx(files.boxes.buf, files.boxes.name)
  const products = await readProductsXlsx(files.products.buf, files.products.name)
  const [current, fingerprint] = await Promise.all([loadCurrentCatalog(), catalogFingerprint()])
  const plan = buildImportPlan({ products: products.rows, boxes: boxes.rows, current, files: { products: products.info, boxes: boxes.info }, catalogFingerprint: fingerprint })
  plan.warnings.push(...(await priceWarnings(plan)))
  return plan
}

/** Avisos sobre PREÇOS das famílias que recebem produtos (o motor não lê as tabelas de preço). */
async function priceWarnings(plan: ImportPlan): Promise<PlanWarning[]> {
  const out: PlanWarning[] = []
  const used = new Set(plan.products.map((p) => p.family))
  const accessory = plan.families.find((f) => f.key === 'ACCESSORY')
  if (accessory && used.has('ACCESSORY')) {
    const [rule] = await db
      .select({ method: s.familyPriceRules.method })
      .from(s.familyPriceRules)
      .innerJoin(s.productFamilies, eq(s.productFamilies.id, s.familyPriceRules.familyId))
      .where(eq(s.productFamilies.code, accessory.code))
      .limit(1)
    if (rule?.method === 'INCLUDED') {
      const codes = plan.products.filter((p) => p.family === 'ACCESSORY').map((p) => p.code)
      out.push({
        level: 'WARN',
        code: 'ACCESSORY_INCLUDED_PRICE',
        message: `${codes.length} produto(s) (fitas, caixas de fitas e o adesivo de reparo) entram na família “${accessory.name}”, cuja regra de preço é “incluído”. Essa regra NÃO pode mudar: a família também tem o KIT-HF, que precisa continuar incluído no preço do Hidroforce (com outra regra, toda Proforma de Hidroforce cobraria o kit ou ficaria sem preço). Estes produtos não são acompanhantes de nenhum produto, então nas cotações saem “sem preço” (nunca USD 0). Antes de dar caixa a eles ou cotá-los, mova-os para uma família própria (ex.: “Fitas e reparos”) e cadastre o preço dela em Preços de exportação.`,
        codes,
      })
    }
  }
  const created = plan.families.filter((f) => f.action === 'CREATE' && used.has(f.key))
  if (created.length)
    out.push({
      level: 'INFO',
      code: 'NEW_FAMILY_NO_PRICE',
      message: `Família(s) nova(s) sem preço de exportação: ${created.map((f) => `“${f.name}”`).join(', ')}. Depois de aplicar, cadastre a regra e os preços em Preços de exportação (sem isso os produtos delas saem sem preço nas cotações).`,
    })
  return out
}

/**
 * PRÉVIA da importação: lê as planilhas, monta o plano e grava em catalog_import (status PREVIEW).
 * Prévias anteriores ainda não aplicadas passam a SUPERSEDED (só a mais recente pode ser aplicada).
 */
export async function createCatalogImportPreview(files: { products: UploadedSheet; boxes: UploadedSheet }, user: { id: number }): Promise<{ id: number; summary: Summary }> {
  const plan = await buildPlanFromSheets(files)
  const id = await db.transaction(async (tx) => {
    await tx.update(s.catalogImports).set({ status: 'SUPERSEDED' }).where(eq(s.catalogImports.status, 'PREVIEW'))
    const [row] = await tx
      .insert(s.catalogImports)
      .values({
        status: 'PREVIEW',
        engineVersion: plan.engineVersion,
        productsFile: plan.files.products.name,
        productsSha256: plan.files.products.sha256,
        boxesFile: plan.files.boxes.name,
        boxesSha256: plan.files.boxes.sha256,
        catalogFingerprint: plan.catalogFingerprint,
        plan,
        summary: plan.summary,
        createdBy: user.id,
      })
      .returning({ id: s.catalogImports.id })
    await tx.insert(s.auditLog).values({
      entity: 'catalog_import',
      entityId: row.id,
      action: 'preview',
      userId: user.id,
      diff: {
        files: { products: plan.files.products.name, boxes: plan.files.boxes.name },
        sha256: { products: plan.files.products.sha256, boxes: plan.files.boxes.sha256 },
        engineVersion: plan.engineVersion,
        planned: plan.summary.planned,
        pending: plan.summary.pending,
        deactivations: plan.summary.deactivations,
        blockers: plan.warnings.filter((w) => w.level === 'BLOCKER').map((w) => w.code),
      },
    })
    return row.id
  })
  return { id, summary: plan.summary }
}

/** Descarta uma prévia ainda não aplicada (fica no histórico como DISCARDED). */
export async function discardCatalogImport(id: number, userId: number): Promise<boolean> {
  const rows = await db
    .update(s.catalogImports)
    .set({ status: 'DISCARDED' })
    .where(and(eq(s.catalogImports.id, id), inArray(s.catalogImports.status, ['PREVIEW'])))
    .returning({ id: s.catalogImports.id })
  if (!rows.length) return false
  await db.insert(s.auditLog).values({ entity: 'catalog_import', entityId: id, action: 'discard', userId })
  return true
}
