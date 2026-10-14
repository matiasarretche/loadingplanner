// Sem 'server-only': também é usado pelo script de linha de comando (scripts/catalog-import-dry-run.ts).
// A revalidação das telas fica na server action (fora do Next não existe cache para revalidar).
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { todayBR } from '@/domain/exportTracking'
import { ENGINE_VERSION, type ApplyResult, type ImportPlan, type PlannedPackaging, type PlannedProduct } from '@/domain/catalogImport/types'
import { isUniqueViolation } from '@/lib/dbErrors'
import { catalogFingerprint, loadCurrentCatalog } from './currentCatalog'

/** Erro com mensagem pronta para o usuário (pt-BR). */
export class CatalogImportError extends Error {}

/** sentinela para desfazer a transação da simulação (dryRun) levando o resultado junto */
class Rollback extends Error {
  constructor(readonly result: ApplyResult) {
    super('rollback')
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type PvInsert = typeof s.packagingVersions.$inferInsert
type PvRow = typeof s.packagingVersions.$inferSelect

const CHUNK = 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

/** impasse do PostgreSQL (40P01: outra transação travava o catálogo), inclusive quando embrulhado pelo Drizzle */
function isDeadlock(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    if ((cur as { code?: string }).code === '40P01') return true
  }
  return false
}

const STATUS_MSG: Record<string, string> = {
  APPLIED: 'Esta importação já foi aplicada.',
  SYNCING: 'Esta importação já foi aplicada (montagens de palete em atualização).',
  SYNCED: 'Esta importação já foi aplicada.',
  SYNC_FAILED: 'Esta importação já foi aplicada (falta atualizar as montagens de palete).',
  DISCARDED: 'Esta prévia foi descartada — gere uma prévia nova.',
  SUPERSEDED: 'Existe uma prévia mais nova — abra a mais recente (ou gere outra).',
}

/** texto das observações da embalagem gravada pela importação */
function packNotes(id: number, pk: PlannedPackaging): string {
  const src = pk.boxSource === 'SHEET' ? `caixa ${pk.boxCode ?? '—'} (tabela de caixas, linha ${pk.boxSheetRow ?? '—'})` : 'caixa atual do catálogo'
  return [`Importação do catálogo oficial #${id} · ${src} · ${pk.reason}`, ...pk.notes].filter(Boolean).join(' · ')
}

/** campos da embalagem planejada (sem variante, versão nem datas) */
function packFields(id: number, pk: PlannedPackaging, palletTypeId: number | null) {
  return {
    packageType: 'Caixa',
    lengthMm: pk.lengthMm,
    widthMm: pk.widthMm,
    heightMm: pk.heightMm,
    netKg: r3(pk.netKg),
    grossKg: r3(pk.grossKg),
    unitsPerPackage: pk.unitsPerPackage,
    unitsPerPallet: pk.unitsPerPallet,
    palletTypeId,
    allowedOrientations: [...pk.allowedOrientations],
    stackable: true,
    verification: pk.verification,
    notes: packNotes(id, pk),
  } satisfies Partial<PvInsert>
}

/** a embalagem vigente já é igual à planejada? (observações e datas não contam) */
function samePack(cur: PvRow, f: ReturnType<typeof packFields>): boolean {
  const orient = (a: string[]) => [...a].sort().join(',')
  return (
    cur.lengthMm === f.lengthMm &&
    cur.widthMm === f.widthMm &&
    cur.heightMm === f.heightMm &&
    r3(cur.netKg) === f.netKg &&
    r3(cur.grossKg) === f.grossKg &&
    cur.unitsPerPackage === f.unitsPerPackage &&
    (cur.unitsPerPallet ?? null) === (f.unitsPerPallet ?? null) &&
    (cur.palletTypeId ?? null) === (f.palletTypeId ?? null) &&
    orient(cur.allowedOrientations ?? []) === orient(f.allowedOrientations) &&
    cur.stackable === f.stackable &&
    cur.verification === f.verification &&
    cur.packageType === f.packageType
  )
}

/** dados da variante gravados pela importação (criar e atualizar) */
function variantFields(p: PlannedProduct) {
  return {
    name: p.name,
    brand: p.brand,
    thicknessUm: p.thicknessUm,
    diameterFt: p.diameterFt,
    widthM: p.widthM,
    lengthM: p.lengthM,
    lengthFt: p.lengthFt,
    ean: p.ean,
    eanStatus: p.eanStatus,
    notes: p.notes,
  }
}

/**
 * APLICA a prévia `id` ao catálogo, numa transação só (tudo ou nada):
 *  1. confere a prévia (PREVIEW, mesma versão do motor, sem bloqueios) e trava as tabelas do catálogo;
 *  2. confere que o catálogo não mudou desde a prévia (impressão digital);
 *  3. cria famílias e linhas que faltam; cria/atualiza os produtos (SKU = código oficial);
 *  4. embalagens: v1 para produto novo; produto existente com embalagem diferente → atualiza, ou cria
 *     v(n+1) se a vigente já foi usada em carga salva (histórico preservado). Pendentes ficam sem caixa;
 *  5. desativa os produtos atuais que saem do catálogo (nunca apaga) e garante os mantidos (KIT-HF) ativos;
 *  6. auditoria e status APPLIED.
 * `dryRun`: faz tudo e desfaz no fim (simulação), devolvendo o mesmo resultado.
 * As montagens de palete são atualizadas depois, fora desta transação (sync.ts).
 */
export async function applyCatalogImport(id: number, userId: number, o: { dryRun?: boolean } = {}): Promise<ApplyResult> {
  const t0 = Date.now()
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.select().from(s.catalogImports).where(eq(s.catalogImports.id, id)).for('update')
      if (!row) throw new CatalogImportError('Importação não encontrada.')
      if (row.status !== 'PREVIEW') throw new CatalogImportError(STATUS_MSG[row.status] ?? 'Esta prévia não pode mais ser aplicada.')
      const plan = row.plan as ImportPlan
      if (plan.engineVersion !== ENGINE_VERSION) throw new CatalogImportError('A prévia foi gerada por outra versão do sistema — gere a prévia de novo.')
      const blockers = plan.warnings.filter((w) => w.level === 'BLOCKER')
      if (blockers.length) throw new CatalogImportError(`A prévia tem bloqueios: ${blockers.map((b) => b.message).join(' · ')}`)

      // ninguém altera o catálogo enquanto a importação grava (as edições esperam o fim da transação). Ordem das
      // travas: perímetros → famílias → produtos → variantes → embalagens → paletes — a mesma do recálculo e da
      // edição manual de silo-bolsa (src/lib/siloPerimeters.ts), que travam family_perimeter primeiro: sem impasse
      await tx.execute(sql`LOCK TABLE family_perimeter, product_family, product, product_variant, packaging_version, pallet_type IN SHARE ROW EXCLUSIVE MODE`)
      if ((await catalogFingerprint(tx)) !== row.catalogFingerprint) throw new CatalogImportError('O catálogo mudou desde a prévia — gere a prévia de novo.')

      const result = await applyPlan(tx, id, plan, userId)
      result.dryRun = Boolean(o.dryRun)

      const created = plan.products.filter((p) => p.action === 'CREATE').map((p) => p.code)
      const updated = plan.products.filter((p) => p.action === 'UPDATE').map((p) => p.code)
      result.durationMs = Date.now() - t0
      await tx.insert(s.auditLog).values({
        entity: 'catalog_import',
        entityId: id,
        action: 'apply',
        userId,
        diff: {
          counts: { ...result, durationMs: undefined },
          created,
          updated,
          deactivated: plan.deactivations.variants.map((d) => d.sku),
          files: { products: row.productsFile, boxes: row.boxesFile },
          sha: { products: row.productsSha256, boxes: row.boxesSha256 },
          engineVersion: plan.engineVersion,
          decisionsId: plan.decisionsId,
        },
      })
      await tx.update(s.catalogImports).set({ status: 'APPLIED', appliedAt: new Date(), appliedBy: userId, result, error: null }).where(eq(s.catalogImports.id, id))
      if (o.dryRun) throw new Rollback(result)
      return result
    })
  } catch (e) {
    if (e instanceof Rollback) return { ...e.result, durationMs: Date.now() - t0 }
    if (e instanceof CatalogImportError) throw e
    if (isUniqueViolation(e)) throw new CatalogImportError('Um dos códigos já existe no catálogo (alguém cadastrou durante a prévia?) — gere a prévia de novo.')
    if (isDeadlock(e)) throw new CatalogImportError('Outra alteração do catálogo estava em andamento — tente de novo.')
    throw e
  }
}

async function applyPlan(tx: Tx, id: number, plan: ImportPlan, userId: number): Promise<ApplyResult> {
  const res: ApplyResult = {
    dryRun: false,
    familiesCreated: [],
    linesCreated: [],
    variantsCreated: 0,
    variantsUpdated: 0,
    packagingCreated: 0,
    packagingNewVersions: 0,
    packagingUnchanged: 0,
    deactivated: 0,
    reactivated: [],
    pendingWithoutPackaging: 0,
    durationMs: 0,
  }
  const today = todayBR()
  const now = new Date()
  const usedFamilies = new Set(plan.products.map((p) => p.family))

  // ---- famílias: cria as que faltam (Filmes em rolo, Hidropeso…) e reativa as usadas que estiverem inativas
  const famByKey = new Map(plan.families.map((f) => [f.key, f]))
  for (const f of plan.families) {
    if (f.action !== 'CREATE' || !usedFamilies.has(f.key)) continue
    const ins = await tx
      .insert(s.productFamilies)
      .values({ code: f.code, name: f.name, sort: f.sort ?? 0, active: true })
      .onConflictDoNothing({ target: s.productFamilies.code })
      .returning({ id: s.productFamilies.id })
    if (ins.length) res.familiesCreated.push(f.name)
  }
  const families = await tx.select().from(s.productFamilies)
  const famIdByKey = new Map<string, number>()
  for (const key of usedFamilies) {
    const ref = famByKey.get(key)
    const fam = ref && families.find((x) => x.code === ref.code)
    if (!fam) throw new CatalogImportError(`Família ${ref?.name ?? key} não encontrada no catálogo — gere a prévia de novo.`)
    famIdByKey.set(key, fam.id)
    if (!fam.active) {
      await tx.update(s.productFamilies).set({ active: true }).where(eq(s.productFamilies.id, fam.id))
      res.reactivated.push(`família ${fam.name}`)
    }
  }

  // ---- linhas (tabela product): encontra pelo nome dentro da família ou cria
  const lines = await tx.select().from(s.products)
  const lineId = new Map<string, number>()
  const lineKey = (familyId: number, name: string) => `${familyId}|${name}`
  for (const l of lines) if (!lineId.has(lineKey(l.familyId, l.name)) || l.active) lineId.set(lineKey(l.familyId, l.name), l.id)
  for (const p of plan.products) {
    const fid = famIdByKey.get(p.family)!
    const k = lineKey(fid, p.productLine)
    const existing = lineId.get(k)
    if (existing != null) {
      const l = lines.find((x) => x.id === existing)
      if (l && !l.active) {
        await tx.update(s.products).set({ active: true, updatedAt: now, updatedBy: userId }).where(eq(s.products.id, l.id))
        l.active = true
        res.reactivated.push(`linha ${l.name}`)
      }
      continue
    }
    const [ins] = await tx.insert(s.products).values({ familyId: fid, name: p.productLine, createdBy: userId, updatedBy: userId }).returning({ id: s.products.id })
    lineId.set(k, ins.id)
    lines.push({ id: ins.id, familyId: fid, name: p.productLine, notes: null, active: true, createdAt: now, createdBy: userId, updatedAt: now, updatedBy: userId })
    res.linesCreated.push(p.productLine)
  }
  const productIdOf = (p: PlannedProduct) => lineId.get(lineKey(famIdByKey.get(p.family)!, p.productLine))!

  // ---- paletes (código → id) e catálogo atual (para atualizar e copiar a verificação dos equivalentes)
  const pallets = new Map((await tx.select({ id: s.palletTypes.id, code: s.palletTypes.code }).from(s.palletTypes)).map((p) => [p.code, p.id]))
  const palletIdOf = (pk: PlannedPackaging) => {
    if (!pk.palletTypeCode) return null
    const pid = pallets.get(pk.palletTypeCode)
    if (pid == null) throw new CatalogImportError(`Tipo de palete ${pk.palletTypeCode} não cadastrado — cadastre-o (Cadastros › Paletes) e gere a prévia de novo.`)
    return pid
  }
  const current = await loadCurrentCatalog(tx)
  const currentById = new Map(current.variants.map((v) => [v.variantId, v]))
  // verificação herdada: produto novo equivalente a um atual VERIFICADO com a mesma caixa → copia quando e quem verificou
  const verifiedPvIds = plan.products
    .filter((p) => p.action === 'CREATE' && p.packaging?.verification === 'VERIFIED' && p.match)
    .map((p) => currentById.get(p.match!.variantId)?.pack?.packagingVersionId)
    .filter((x): x is number => x != null)
  const verifiedInfo = new Map<number, { verifiedAt: string | null; verifiedBy: string | null }>()
  if (verifiedPvIds.length) {
    const rows = await tx.select({ id: s.packagingVersions.id, verifiedAt: s.packagingVersions.verifiedAt, verifiedBy: s.packagingVersions.verifiedBy }).from(s.packagingVersions).where(inArray(s.packagingVersions.id, verifiedPvIds))
    for (const r of rows) verifiedInfo.set(r.id, { verifiedAt: r.verifiedAt, verifiedBy: r.verifiedBy })
  }

  // ---- produtos NOVOS (em lotes)
  const creates = plan.products.filter((p) => p.action === 'CREATE')
  const createdId = new Map<string, number>()
  for (let i = 0; i < creates.length; i += CHUNK) {
    const chunk = creates.slice(i, i + CHUNK)
    const rows = await tx
      .insert(s.productVariants)
      .values(chunk.map((p) => ({ productId: productIdOf(p), sku: p.code, ...variantFields(p), attrs: p.attrs, active: true, createdBy: userId, updatedBy: userId })))
      .returning({ id: s.productVariants.id, sku: s.productVariants.sku })
    for (const r of rows) createdId.set(r.sku, r.id)
  }
  res.variantsCreated = createdId.size

  const packInserts: PvInsert[] = []
  for (const p of creates) {
    if (!p.packaging) {
      res.pendingWithoutPackaging++
      continue
    }
    const f = packFields(id, p.packaging, palletIdOf(p.packaging))
    const ver = f.verification === 'VERIFIED' && p.match ? verifiedInfo.get(currentById.get(p.match.variantId)?.pack?.packagingVersionId ?? -1) : undefined
    packInserts.push({ ...f, ...(ver ?? {}), variantId: createdId.get(p.code)!, version: 1, validFrom: today, createdBy: userId, updatedBy: userId })
  }

  // ---- produtos EXISTENTES (mesmo código: reimportação)
  for (const p of plan.products.filter((x) => x.action === 'UPDATE')) {
    const vid = p.existingVariantId
    const cur = vid != null ? currentById.get(vid) : undefined
    if (vid == null || !cur) throw new CatalogImportError(`Produto ${p.code} não encontrado no catálogo — gere a prévia de novo.`)
    const attrs: Record<string, string | number | null> = { ...cur.attrs, ...p.attrs }
    if (p.packaging) delete attrs.caixa_sugerida
    const [before] = await tx.select({ active: s.productVariants.active }).from(s.productVariants).where(eq(s.productVariants.id, vid))
    // sem problema de dados na planilha (notes null): mantém as observações digitadas no Catálogo
    const { notes, ...fields } = variantFields(p)
    await tx
      .update(s.productVariants)
      .set({ productId: productIdOf(p), ...fields, ...(notes != null ? { notes } : {}), attrs, active: true, updatedAt: now, updatedBy: userId })
      .where(eq(s.productVariants.id, vid))
    res.variantsUpdated++
    if (before && !before.active) res.reactivated.push(p.code)

    if (!p.packaging) {
      // pendente: mantém a embalagem que já tem (se não tem, fica sem caixa até ser definida no Catálogo)
      if (!cur.pack) res.pendingWithoutPackaging++
      continue
    }
    const f = packFields(id, p.packaging, palletIdOf(p.packaging))
    if (!cur.pack) {
      packInserts.push({ ...f, variantId: vid, version: 1, validFrom: today, createdBy: userId, updatedBy: userId })
      continue
    }
    const [pv] = await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.id, cur.pack.packagingVersionId))
    if (samePack(pv, f)) {
      res.packagingUnchanged++
      continue
    }
    const keepVerified = f.verification === 'VERIFIED' ? { verifiedAt: pv.verifiedAt, verifiedBy: pv.verifiedBy } : { verifiedAt: null, verifiedBy: null }
    if (pv.locked) {
      // embalagem já usada em carga salva: encerra a vigente e cria v(n+1) — as cargas guardam a cópia da época
      await tx.update(s.packagingVersions).set({ validTo: today, updatedAt: now, updatedBy: userId }).where(eq(s.packagingVersions.id, pv.id))
      const copy: Partial<PvRow> = { ...pv }
      for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
      await tx.insert(s.packagingVersions).values({ ...(copy as PvInsert), ...f, ...keepVerified, variantId: vid, version: pv.version + 1, validFrom: today, validTo: null, locked: false, createdBy: userId, updatedBy: userId })
      res.packagingNewVersions++
    } else {
      await tx.update(s.packagingVersions).set({ ...f, ...keepVerified, updatedAt: now, updatedBy: userId }).where(eq(s.packagingVersions.id, pv.id))
      res.packagingNewVersions++
    }
  }

  for (let i = 0; i < packInserts.length; i += CHUNK) await tx.insert(s.packagingVersions).values(packInserts.slice(i, i + CHUNK))
  res.packagingCreated = packInserts.length

  // ---- saem do catálogo: desativa (nunca apaga; as cargas salvas guardam a cópia da época)
  const keep = plan.deactivations.keptActive.map((k) => k.sku)
  const ids = plan.deactivations.variants.map((d) => d.variantId)
  if (ids.length) {
    const off = await tx
      .update(s.productVariants)
      .set({ active: false, updatedAt: now, updatedBy: userId })
      .where(and(inArray(s.productVariants.id, ids), eq(s.productVariants.active, true), keep.length ? notInArray(s.productVariants.sku, keep) : undefined))
      .returning({ id: s.productVariants.id })
    res.deactivated = off.length
  }
  // mantidos (ex.: KIT-HF, acompanhante do Hidroforce): garante ativos
  if (keep.length) {
    const on = await tx
      .update(s.productVariants)
      .set({ active: true, updatedAt: now, updatedBy: userId })
      .where(and(inArray(s.productVariants.sku, keep), eq(s.productVariants.active, false)))
      .returning({ sku: s.productVariants.sku })
    res.reactivated.push(...on.map((r) => r.sku))
  }
  return res
}
