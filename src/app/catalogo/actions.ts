'use server'

import { after } from 'next/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db, schema as s } from '@/db'
import { eanStatusOf } from '@/domain/catalogImport/ean'
import { isOrientation } from '@/domain/geometry'
import { todayBR } from '@/domain/exportTracking'
import { parseTechOption } from '@/domain/technology'
import { assertUser } from '@/lib/auth'
import { diffRecords, logAudit } from '@/lib/audit'
import { isUniqueViolation } from '@/lib/dbErrors'
import { syncCompositionsWithCatalog } from '@/lib/refreshCompositions'

export interface ActionResult {
  ok?: boolean
  error?: string
  fieldErrors?: Record<string, string>
}

export interface CatalogItemInput {
  variantId: number | null
  familyId: string
  line: string
  sku: string
  name: string
  lengthMm: string
  widthMm: string
  heightMm: string
  netKg: string
  grossKg: string
  unitsPerPallet: string
  unitsPerPackage: string
  palletTypeId: string
  packageType: string
  verification: string
  stackable: boolean
  allowedOrientations: string[]
  /** marca comercial (vazio = Pacifil) */
  brand: string
  /** espessura do filme em µm (vazio = não informada) */
  thicknessUm: string
  /** medidas do produto (vazio = não informada) */
  diameterFt: string
  widthM: string
  lengthM: string
  lengthFt: string
  /** código de barras (só dígitos, 8 a 14; vazio = sem EAN) — guardado como texto, com o estado de validade */
  ean: string
  /** código da caixa na tabela de caixas (attrs.codigo_caixa; vazio = remove) */
  boxCode: string
  notes: string
  /** preço de referência (vazio = sem preço) */
  price: string
  priceCurrency: string
  priceUnit: string
}

const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)
const dec = (v: string) => (/^\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(',', '.')) : NaN)

function revalidate() {
  revalidatePath('/catalogo')
  // a lista de preços lê as famílias (e a tecnologia NXT de cada uma)
  revalidatePath('/precos-exportacao')
}

/** Cria ou atualiza um produto (SKU) com sua embalagem vigente. Alterar embalagem já usada em carga cria nova versão. */
export async function saveCatalogItemAction(input: CatalogItemInput): Promise<ActionResult> {
  const me = await assertUser('editCatalog')
  const fe: Record<string, string> = {}
  const familyId = Number(input.familyId)
  const sku = input.sku.trim().toUpperCase()
  const name = input.name.trim()
  const line = input.line.trim()
  if (!Number.isInteger(familyId) || familyId <= 0) fe.familyId = 'Selecione a família'
  if (!sku) fe.sku = 'Obrigatório'
  if (!name) fe.name = 'Obrigatório'
  const price = input.price.trim() === '' ? null : dec(input.price)
  if (price !== null && !(price >= 0)) fe.price = 'Número (ex.: 1250 ou 1250,50)'
  const priceCurrency = (input.priceCurrency || 'USD').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(priceCurrency)) fe.priceCurrency = 'Código de 3 letras (USD, BRL, EUR)'
  // espessura (µm): campo próprio; vazio = não informada (fica destacada até ser cadastrada)
  const thicknessUm = (input.thicknessUm ?? '').trim() === '' ? null : int(input.thicknessUm)
  if (thicknessUm !== null && !(thicknessUm > 0 && thicknessUm <= 5000)) fe.thicknessUm = 'Inteiro em µm (ex.: 220)'
  // medidas do produto (campos próprios): vazio = não informada; nunca convertidas/inventadas
  const measure = (k: 'diameterFt' | 'widthM' | 'lengthM' | 'lengthFt', max: number) => {
    const raw = (input[k] ?? '').trim()
    if (raw === '') return null
    const n = dec(raw)
    if (!(n > 0 && n <= max)) fe[k] = 'Número maior que zero (ex.: 9 ou 9,5)'
    return n
  }
  const diameterFt = measure('diameterFt', 100)
  const widthM = measure('widthM', 200)
  const lengthM = measure('lengthM', 5000)
  const lengthFt = measure('lengthFt', 20000)
  const priceUnit = (['UNIT', 'BOX', 'PALLET'].includes(input.priceUnit) ? input.priceUnit : 'UNIT') as 'UNIT' | 'BOX' | 'PALLET'
  // EAN: texto exatamente como digitado (nunca número); o estado (EAN-13 / GTIN-14 / inválido) não bloqueia
  const ean = (input.ean ?? '').trim() || null
  if (ean !== null && !/^\d{8,14}$/.test(ean)) fe.ean = 'Só dígitos (8 a 14)'
  const eanStatus = eanStatusOf(ean).status
  // código da caixa (tabela de caixas): fica em attrs.codigo_caixa, como texto
  const boxCode = (input.boxCode ?? '').trim()
  if (boxCode && !/^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$/.test(boxCode)) fe.boxCode = 'Código da caixa (ex.: 69490)'
  const withBoxCode = (attrs: Record<string, string | number | null> | null | undefined) => {
    // mantém a ordem das chaves (a auditoria compara por JSON)
    const out: Record<string, string | number | null> = { ...(attrs ?? {}) }
    if (boxCode) out.codigo_caixa = boxCode
    else delete out.codigo_caixa
    return out
  }

  // Embalagem: opcional, mas se informar algo, medidas e pesos são obrigatórios
  const packFields = [input.lengthMm, input.widthMm, input.heightMm, input.netKg, input.grossKg, input.unitsPerPallet]
  const hasPack = packFields.some((v) => v.trim() !== '')
  let pack: null | {
    lengthMm: number
    widthMm: number
    heightMm: number
    netKg: number
    grossKg: number
    unitsPerPallet: number | null
    unitsPerPackage: number
    palletTypeId: number | null
    packageType: string
    verification: 'VERIFIED' | 'ESTIMATED' | 'UNVERIFIED'
    stackable: boolean
    allowedOrientations: string[]
  } = null
  if (hasPack) {
    const l = int(input.lengthMm), w = int(input.widthMm), h = int(input.heightMm)
    const net = dec(input.netKg), gross = dec(input.grossKg)
    const upp = input.unitsPerPallet.trim() === '' ? null : int(input.unitsPerPallet)
    const upk = input.unitsPerPackage.trim() === '' ? 1 : int(input.unitsPerPackage)
    for (const [k, v] of [['lengthMm', l], ['widthMm', w], ['heightMm', h]] as const) if (!(v > 0)) fe[k] = 'Inteiro em mm, maior que zero'
    if (!(net >= 0)) fe.netKg = 'Número (ex.: 147 ou 52,5)'
    if (!(gross >= 0)) fe.grossKg = 'Número (ex.: 153,5)'
    if (net >= 0 && gross >= 0 && gross < net) fe.grossKg = 'O peso com embalagem não pode ser menor que o líquido'
    if (upp !== null && !(upp > 0)) fe.unitsPerPallet = 'Inteiro maior que zero'
    if (!(upk > 0)) fe.unitsPerPackage = 'Inteiro maior que zero'
    const orients = input.allowedOrientations.filter(isOrientation)
    if (!orients.length) fe.allowedOrientations = 'Selecione pelo menos uma'
    const ver = ['VERIFIED', 'ESTIMATED', 'UNVERIFIED'].includes(input.verification) ? (input.verification as 'VERIFIED') : 'UNVERIFIED'
    pack = {
      lengthMm: l,
      widthMm: w,
      heightMm: h,
      netKg: net,
      grossKg: gross,
      unitsPerPallet: upp,
      unitsPerPackage: upk,
      palletTypeId: input.palletTypeId ? Number(input.palletTypeId) : null,
      packageType: input.packageType.trim() || 'Caixa',
      verification: ver,
      stackable: input.stackable,
      allowedOrientations: orients,
    }
  }
  if (Object.keys(fe).length) return { error: 'Corrija os campos destacados.', fieldErrors: fe }

  const fam = await db.query.productFamilies.findFirst({ where: eq(s.productFamilies.id, familyId) })
  if (!fam) return { error: 'Família não encontrada.' }
  const lineName = line || fam.name

  try {
    // tudo ou nada: produto, SKU e embalagem numa transação (um erro no meio não deixa registro órfão)
    const fail = await db.transaction(async (tx) => {
      // linha/produto: encontra ou cria dentro da família
      let product = await tx.query.products.findFirst({ where: and(eq(s.products.familyId, familyId), eq(s.products.name, lineName)) })
      if (!product) [product] = await tx.insert(s.products).values({ familyId, name: lineName, createdBy: me.id, updatedBy: me.id }).returning()
  
      let variantId = input.variantId
      const brand = (input.brand ?? '').trim() || 'Pacifil'
      const vData = { productId: product.id, sku, name, brand, thicknessUm, diameterFt, widthM, lengthM, lengthFt, ean, eanStatus, notes: input.notes.trim() || null, active: true, price, priceCurrency, priceUnit }
      if (variantId == null) {
        const attrs = withBoxCode({})
        const [v] = await tx.insert(s.productVariants).values({ ...vData, attrs, ...(price !== null ? { priceUpdatedAt: new Date() } : {}), createdBy: me.id, updatedBy: me.id }).returning()
        variantId = v.id
        await logAudit('product_variant', v.id, 'create', me.id, { ...vData, attrs })
      } else {
        const before = await tx.query.productVariants.findFirst({ where: eq(s.productVariants.id, variantId) })
        if (!before) return { error: 'Produto não encontrado.' } as ActionResult
        const priceChanged = before.price !== price || before.priceCurrency !== priceCurrency || before.priceUnit !== priceUnit
        // atributos: só o código da caixa muda aqui; os demais (técnicos, da importação) ficam como estão
        const attrs = withBoxCode(before.attrs)
        await tx
          .update(s.productVariants)
          .set({ ...vData, attrs, ...(priceChanged ? { priceUpdatedAt: new Date() } : {}), updatedBy: me.id, updatedAt: new Date() })
          .where(eq(s.productVariants.id, variantId))
        await logAudit('product_variant', variantId, 'update', me.id, diffRecords(before, { ...vData, attrs }))
      }
  
      if (pack) {
        const [cur] = await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, variantId)).orderBy(desc(s.packagingVersions.version)).limit(1)
        // dia de hoje em São Paulo (o servidor roda em UTC: depois das 21 h já seria amanhã)
        const today = todayBR()
        if (!cur) {
          await tx.insert(s.packagingVersions).values({ ...pack, variantId, version: 1, validFrom: today, createdBy: me.id, updatedBy: me.id })
        } else {
          const changes = diffRecords(cur as unknown as Record<string, unknown>, pack)
          if (Object.keys(changes).length) {
            if (cur.locked) {
              // versão já usada em carga salva: preserva o histórico criando v(n+1)
              await tx.update(s.packagingVersions).set({ validTo: today }).where(and(eq(s.packagingVersions.id, cur.id), isNull(s.packagingVersions.validTo)))
              const copy: Partial<typeof cur> = { ...cur }
              for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
              await tx.insert(s.packagingVersions).values({ ...(copy as typeof s.packagingVersions.$inferInsert), ...pack, variantId, version: cur.version + 1, validFrom: today, validTo: null, locked: false, createdBy: me.id, updatedBy: me.id })
              await logAudit('packaging_version', cur.id, 'new_version', me.id, changes)
            } else {
              await tx.update(s.packagingVersions).set({ ...pack, updatedBy: me.id, updatedAt: new Date() }).where(eq(s.packagingVersions.id, cur.id))
              await logAudit('packaging_version', cur.id, 'update', me.id, changes)
            }
          }
        }
      }
        return null
    })
    if (fail) return fail
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Já existe um produto com o código ${sku}.`, fieldErrors: { sku: 'Código já cadastrado' } }
    throw e
  }
  // montagens de palete passam a usar os dados novos (cargas salvas mantêm o snapshot)
  // paletes padrão (REF) atualizados depois da resposta (salvar o catálogo não espera o recálculo)
  after(() => syncCompositionsWithCatalog(me.id))
  revalidate()
  return { ok: true }
}

/** Excluir produto = desativar (cargas salvas mantêm cópia; histórico preservado). */
export async function deleteCatalogItemAction(variantId: number): Promise<ActionResult> {
  const me = await assertUser('editCatalog')
  const v = await db.query.productVariants.findFirst({ where: eq(s.productVariants.id, variantId) })
  if (!v) return { error: 'Produto não encontrado.' }
  await db.update(s.productVariants).set({ active: false, updatedBy: me.id, updatedAt: new Date() }).where(eq(s.productVariants.id, variantId))
  await logAudit('product_variant', variantId, 'delete', me.id, { sku: v.sku })
  // paletes padrão (REF) atualizados depois da resposta (salvar o catálogo não espera o recálculo)
  after(() => syncCompositionsWithCatalog(me.id))
  revalidate()
  return { ok: true }
}

/**
 * Cria ou atualiza uma família. `tech` = tecnologia comercial nos PDFs (src/domain/technology.ts):
 * '' = nenhuma, 'NXT:MENTION' (texto) ou 'NXT:SEAL' (selo + texto); omitido = não muda.
 */
export async function saveFamilyAction(input: { id: number | null; name: string; code: string; tech?: string }): Promise<ActionResult> {
  const me = await assertUser('editCatalog')
  const name = input.name.trim()
  if (!name) return { error: 'Informe o nome da família.', fieldErrors: { name: 'Obrigatório' } }
  const tech = input.tech === undefined ? undefined : parseTechOption(input.tech)
  if (input.tech !== undefined && tech === undefined) return { error: 'Tecnologia inválida.', fieldErrors: { tech: 'Inválida' } }
  const techCols = tech === undefined ? {} : { technology: tech?.key ?? null, technologyDisplay: tech?.display ?? null }
  const code =
    input.code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_') ||
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  try {
    if (input.id == null) {
      const [{ max }] = await db.select({ max: s.productFamilies.sort }).from(s.productFamilies).orderBy(desc(s.productFamilies.sort)).limit(1)
      const [f] = await db.insert(s.productFamilies).values({ name, code, sort: (max ?? 0) + 1, ...techCols }).returning()
      await logAudit('product_family', f.id, 'create', me.id, { name, code, ...techCols })
    } else {
      const [before] = await db.select().from(s.productFamilies).where(eq(s.productFamilies.id, input.id))
      if (!before) return { error: 'Família não encontrada.' }
      await db.update(s.productFamilies).set({ name, code, active: true, ...techCols }).where(eq(s.productFamilies.id, input.id))
      await logAudit('product_family', input.id, 'update', me.id, diffRecords(before, { name, code, active: true, ...techCols }))
    }
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `Já existe uma família com o código ${code}.`, fieldErrors: { code: 'Código já usado' } }
    throw e
  }
  revalidate()
  return { ok: true }
}

/** Excluir família: só se não tiver produtos ativos (evita esconder produtos sem querer). */
export async function deleteFamilyAction(id: number): Promise<ActionResult> {
  const me = await assertUser('editCatalog')
  const active = await db
    .select({ id: s.productVariants.id })
    .from(s.productVariants)
    .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
    .where(and(eq(s.products.familyId, id), eq(s.productVariants.active, true)))
  if (active.length) return { error: `A família tem ${active.length} produto(s) ativo(s). Exclua ou mova os produtos antes de excluir a família.` }
  await db.update(s.productFamilies).set({ active: false }).where(eq(s.productFamilies.id, id))
  await logAudit('product_family', id, 'delete', me.id)
  revalidate()
  return { ok: true }
}
