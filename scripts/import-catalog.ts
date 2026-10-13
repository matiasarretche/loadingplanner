/**
 * Importa o CATÁLOGO LOGÍSTICO atualizado (Excel no formato exportado por export-catalog.ts, com as
 * colunas técnicas novas). Compara com o banco ANTES de gravar e só altera o que mudou.
 *  - Código = chave (comparação sem diferenciar maiúsculas/minúsculas).
 *  - Produtos novos: cria linha (produto) na família, variante, marca, atributos e embalagem v1.
 *  - Existentes: atualiza descrição, marca, atributos técnicos e preço (se informado); embalagem
 *    alterada → atualiza, ou cria nova versão se já foi usada em carga salva (histórico preservado).
 *  - Produtos do banco que NÃO estão no arquivo: não são alterados (apenas listados).
 *  - Orientações: embalagens no padrão antigo (só em pé) passam a livres (regra: todas as faces),
 *    salvo restrição cadastrada de outra forma.
 *  - Produtos com kits por cima (atributo acessorio_sku, ex.: Hydroforce + KIT-HF): "Caixas / palete"
 *    diferente do sistema NÃO é aplicado (aviso) — a quantidade do palete com os kits foi decidida no
 *    sistema (ex.: HF-2M-2K 52, planilha antiga 60). Para aplicar mesmo assim: --allow-pallet-change.
 * Uso: npx tsx --env-file=.env scripts/import-catalog.ts arquivo.xlsx [--dry] [--allow-pallet-change]
 */
import ExcelJS from 'exceljs'
import { desc, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { ORIENTATIONS } from '../src/domain/geometry'
import { syncCompositionsWithCatalog } from '../src/lib/refreshCompositions'

type Row = Record<string, unknown>
const VERIF: Record<string, 'VERIFIED' | 'ESTIMATED' | 'UNVERIFIED'> = { verificado: 'VERIFIED', 'estimado / referência': 'ESTIMATED', 'não verificado': 'UNVERIFIED' }
const UNIT: Record<string, 'UNIT' | 'BOX' | 'PALLET'> = { unidade: 'UNIT', caixa: 'BOX', palete: 'PALLET' }
const num = (v: unknown, d = 3): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null
}
const str = (v: unknown) => (v == null ? '' : String(typeof v === 'object' && v && 'text' in v ? (v as { text: string }).text : v).trim())
const same = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.0005 : String(a ?? '') === String(b ?? ''))
/** comparação de nomes sem acento/caixa/espaços ("Eco Bag" = "Ecobag", "Pró Bag" = "Probag") */
const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
/** nomes de família equivalentes (planilha × banco) */
const FAMILY_ALIAS: Record<string, string> = { hidroforce: 'hydroforce' }
const famKey = (x: string) => FAMILY_ALIAS[norm(x)] ?? norm(x)
const r1 = (x: number | null | undefined) => (x == null ? '' : String(Math.round(x * 10) / 10))

/**
 * Identidade técnica de um produto (para reconhecer o MESMO produto com outro código):
 * família, marca, linha, diâmetro/largura, comprimento (m; pés convertidos), espessura e capacidade.
 */
function identity(p: { family: string; brand: string; line: string; diameterFt: number | null; widthM: number | null; lengthM: number | null; thicknessUm: number | null; capacityL: number | null }) {
  return [famKey(p.family), norm(p.brand || 'Pacifil'), norm(p.line).replace('hidroforce', 'hydroforce'), r1(p.diameterFt), r1(p.widthM), r1(p.lengthM), p.thicknessUm ?? '', p.capacityL ?? ''].join('|')
}

async function readRows(file: string): Promise<Row[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet('Catálogo logístico') ?? wb.worksheets[0]
  const head: string[] = []
  ws.getRow(1).eachCell((c, i) => (head[i] = str(c.value)))
  const out: Row[] = []
  ws.eachRow((r, n) => {
    if (n === 1) return
    const o: Row = {}
    head.forEach((h, i) => {
      if (!h) return
      const v = r.getCell(i).value
      o[h] = v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : v
    })
    if (str(o['Código'])) out.push(o)
  })
  return out
}

async function main() {
  const file = process.argv[2]
  const dry = process.argv.includes('--dry')
  if (!file) throw new Error('Uso: import-catalog.ts arquivo.xlsx [--dry]')
  const rows = await readRows(file)
  const families = await db.select().from(s.productFamilies)
  const products = await db.select().from(s.products)
  const variants = await db.select().from(s.productVariants)
  const pallets = await db.select().from(s.palletTypes)
  const byCode = new Map(pallets.map((p) => [p.code.toUpperCase(), p]))
  const varBySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v]))
  const today = new Date().toISOString().slice(0, 10)

  const rep = { created: [] as string[], updated: [] as string[], reactivated: [] as string[], newVersion: [] as string[], orientations: 0, warnings: [] as string[], unchanged: 0, renamed: [] as string[], deactivated: [] as string[], linesRenamed: [] as string[] }
  const fileSkus = new Set(rows.map((r) => str(r['Código']).toUpperCase()))
  const rename = process.argv.includes('--rename')
  const deactivateMissing = process.argv.includes('--deactivate-missing')
  const allowPalletChange = process.argv.includes('--allow-pallet-change')

  // --rename: o MESMO produto com código novo na planilha (pela identidade técnica) é renomeado, não duplicado
  const renames: { from: (typeof variants)[number]; to: string }[] = []
  if (rename) {
    const famById = new Map(families.map((f) => [f.id, f]))
    const prodById = new Map(products.map((p) => [p.id, p]))
    const idOf = (v: (typeof variants)[number]) => {
      const p = prodById.get(v.productId)
      return identity({
        family: famById.get(p?.familyId ?? -1)?.name ?? '',
        brand: v.brand,
        line: p?.name ?? '',
        diameterFt: v.diameterFt,
        widthM: v.widthM,
        lengthM: v.lengthM ?? (v.lengthFt != null ? v.lengthFt * 0.3048 : null),
        thicknessUm: v.thicknessUm,
        capacityL: typeof v.attrs?.capacidade_l === 'number' ? v.attrs.capacidade_l : null,
      })
    }
    const byId = new Map<string, (typeof variants)[number][]>()
    for (const v of variants) if (!fileSkus.has(v.sku.toUpperCase())) byId.set(idOf(v), [...(byId.get(idOf(v)) ?? []), v])
    for (const r of rows) {
      const sku = str(r['Código'])
      if (varBySku.has(sku.toUpperCase())) continue // código já existe: atualização normal
      const k = identity({
        family: str(r['Família']),
        brand: str(r['Marca']),
        line: str(r['Linha']) || str(r['Família']),
        diameterFt: num(r['Diámetro (pies)'], 2),
        widthM: num(r['Ancho (m)'], 3),
        lengthM: num(r['Largo (m)'], 3),
        thicknessUm: num(r['Espesor (micrones)'], 0),
        capacityL: num(r['Capacidad (L)'], 0),
      })
      const c = byId.get(k) ?? []
      if (c.length === 1) {
        renames.push({ from: c[0], to: sku })
        byId.delete(k)
      } else if (c.length > 1) rep.warnings.push(`${sku}: mais de um produto antigo com a mesma identidade (${c.map((x) => x.sku).join(', ')}) — criado como novo`)
    }
  }
  const renamedFrom = new Set(renames.map((x) => x.from.sku.toUpperCase()))
  const notInFile = variants.filter((v) => v.active && !fileSkus.has(v.sku.toUpperCase()) && !renamedFrom.has(v.sku.toUpperCase())).map((v) => v.sku)
  // acompanhantes obrigatórios (ex.: KIT-HF) nunca são desativados por ausência
  const companionSkus = new Set(variants.map((v) => String(v.attrs?.acessorio_sku ?? '').toUpperCase()).filter(Boolean))

  await db.transaction(async (tx) => {
    // renomeia códigos (e as montagens REF que levam o código no nome) antes de atualizar os dados
    if (renames.length) {
      const comps = await tx.select().from(s.palletCompositions)
      for (const { from, to } of renames) {
        if (!dry) await tx.update(s.productVariants).set({ sku: to, updatedAt: new Date() }).where(eq(s.productVariants.id, from.id))
        for (const c of comps.filter((x) => x.name.startsWith(`REF · ${from.sku} · `))) {
          if (!dry) await tx.update(s.palletCompositions).set({ name: c.name.replace(`REF · ${from.sku} · `, `REF · ${to} · `) }).where(eq(s.palletCompositions.id, c.id))
        }
        varBySku.delete(from.sku.toUpperCase())
        varBySku.set(to.toUpperCase(), { ...from, sku: to })
        rep.renamed.push(`${from.sku} → ${to}`)
      }
    }
    for (const r of rows) {
      const sku = str(r['Código'])
      const famName = str(r['Família'])
      const lineName = str(r['Linha']) || famName
      const fam = families.find((f) => famKey(f.name) === famKey(famName))
      if (!fam) {
        rep.warnings.push(`${sku}: família "${famName}" não existe — linha ignorada`)
        continue
      }
      // família com outra grafia na planilha (ex.: Hidroforce × Hydroforce): adota o nome da planilha
      if (fam.name !== famName) {
        if (!dry) await tx.update(s.productFamilies).set({ name: famName }).where(eq(s.productFamilies.id, fam.id))
        rep.linesRenamed.push(`família ${fam.name} → ${famName}`)
        fam.name = famName
      }
      // atributos técnicos (só os informados; os demais atributos existentes são mantidos)
      const tech: Record<string, string | number | null> = {}
      const put = (k: string, v: number | null) => {
        if (v != null) tech[k] = v
      }
      put('capacidade_l', num(r['Capacidad (L)'], 0))
      put('diametro_m', num(r['Diámetro (m)'], 3))
      put('perimetro_m', num(r['Perímetro (m)'], 3))
      // espessura tem campo próprio (thickness_um); vazio na planilha = não altera
      const thickness = num(r['Espesor (micrones)'], 0)
      // medidas com campos próprios; vazio na planilha = não altera
      const cols = { diameterFt: num(r['Diámetro (pies)'], 2), widthM: num(r['Ancho (m)'], 3), lengthM: num(r['Largo (m)'], 3) }
      const colsSet = Object.fromEntries(Object.entries(cols).filter(([, x]) => x != null))
      const sb = str(r['Silo Bolsa']).toLowerCase()
      if (sb) tech.silo_bolsa = sb.startsWith('s') ? 1 : 0
      const brand = str(r['Marca']) || 'Pacifil'
      const name = str(r['Descrição']) || sku
      const price = num(r['Preço'], 4)
      const currency = str(r['Moeda']) || 'USD'
      const priceUnit = UNIT[str(r['Preço por']).toLowerCase()] ?? 'UNIT'

      // linha (produto) dentro da família
      const lineKey = (x: string) => norm(x).replace('hidroforce', 'hydroforce')
      let product = products.find((p) => p.familyId === fam.id && lineKey(p.name) === lineKey(lineName))
      // mesma linha com outra grafia ("Eco Bag" → "Ecobag"): renomeia a linha em vez de criar outra
      if (product && product.name !== lineName && product.id > 0) {
        if (!dry) await tx.update(s.products).set({ name: lineName }).where(eq(s.products.id, product.id))
        rep.linesRenamed.push(`${product.name} → ${lineName}`)
        product.name = lineName
      }
      if (!product) {
        if (!dry) {
          ;[product] = await tx.insert(s.products).values({ familyId: fam.id, name: lineName }).returning()
          products.push(product)
        } else product = { id: -1, familyId: fam.id, name: lineName } as typeof s.products.$inferSelect
        rep.warnings.push(`linha nova "${lineName}" em ${fam.name}`)
      }

      let v = varBySku.get(sku.toUpperCase())
      const changes: string[] = []
      if (!v) {
        if (!dry) {
          ;[v] = await tx
            .insert(s.productVariants)
            .values({ productId: product.id, sku, name, brand, attrs: tech, thicknessUm: thickness, ...colsSet, price, priceCurrency: currency, priceUnit, ...(price != null ? { priceUpdatedAt: new Date() } : {}) })
            .returning()
          varBySku.set(sku.toUpperCase(), v)
        }
        rep.created.push(`${sku} · ${brand} · ${name}`)
      } else {
        const attrs = { ...(v.attrs ?? {}), ...tech }
        if (!same(v.name, name)) changes.push(`descrição "${v.name}" → "${name}"`)
        if (!same(v.brand, brand)) changes.push(`marca ${v.brand} → ${brand}`)
        if (product.id > 0 && v.productId !== product.id) changes.push(`linha → ${lineName}`)
        const attrDiff = Object.keys(tech).filter((k) => !same(v!.attrs?.[k], tech[k]))
        if (attrDiff.length) changes.push(`atributos (${attrDiff.join(', ')})`)
        const thickChanged = thickness != null && v.thicknessUm !== thickness
        if (thickChanged) changes.push(`espessura ${v.thicknessUm ?? '—'} → ${thickness} µm`)
        const colsChanged = Object.entries(colsSet).filter(([k, x]) => !same((v as Record<string, unknown>)[k], x))
        for (const [k, x] of colsChanged) changes.push(`${k} ${(v as Record<string, unknown>)[k] ?? '—'} → ${x}`)
        const priceChanged = price != null && (!same(v.price, price) || v.priceCurrency !== currency || v.priceUnit !== priceUnit)
        if (priceChanged) changes.push(`preço ${v.price ?? '—'} → ${price} ${currency}`)
        if (!v.active) rep.reactivated.push(sku)
        if (!dry && (changes.length || !v.active)) {
          await tx
            .update(s.productVariants)
            .set({ name, brand, attrs, ...(thickChanged ? { thicknessUm: thickness } : {}), ...Object.fromEntries(colsChanged), active: true, ...(product.id > 0 ? { productId: product.id } : {}), ...(priceChanged ? { price, priceCurrency: currency, priceUnit, priceUpdatedAt: new Date() } : {}), updatedAt: new Date() })
            .where(eq(s.productVariants.id, v.id))
        }
      }

      // embalagem
      const l = num(r['Caixa C (mm)'], 0), w = num(r['Caixa L (mm)'], 0), h = num(r['Caixa A (mm)'], 0)
      const net = num(r['Peso líquido (kg)']), gross = num(r['Peso c/ embalagem (kg)'] ?? r['Peso bruto (kg)'])
      const upp = num(r['Caixas / palete'], 0)
      const palletCode = str(r['Palete']).toUpperCase()
      const pt = palletCode ? byCode.get(palletCode) : undefined
      if (palletCode && !pt) rep.warnings.push(`${sku}: palete ${palletCode} não cadastrado`)
      const verification = VERIF[str(r['Dados']).toLowerCase()] ?? 'ESTIMATED'
      if (l == null || w == null || h == null || gross == null) {
        if (changes.length || !varBySku.get(sku.toUpperCase())) rep.warnings.push(`${sku}: sem medidas/peso da caixa — embalagem não alterada`)
        if (changes.length) rep.updated.push(`${sku}: ${changes.join(' · ')}`)
        else rep.unchanged++
        continue
      }
      const pack = { lengthMm: l, widthMm: w, heightMm: h, netKg: net ?? 0, grossKg: gross, unitsPerPallet: upp, palletTypeId: pt?.id ?? null, verification }
      const vid = v?.id
      const [cur] = vid ? await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, vid)).orderBy(desc(s.packagingVersions.version)).limit(1) : []
      const oldDefault = cur && cur.allowedOrientations.length === 2 && cur.allowedOrientations.includes('LWH') && cur.allowedOrientations.includes('WLH')
      if (!cur) {
        if (!dry && vid) await tx.insert(s.packagingVersions).values({ ...pack, variantId: vid, version: 1, validFrom: today, packageType: 'Caixa', allowedOrientations: [...ORIENTATIONS] })
        if (rep.created.at(-1)?.startsWith(sku) !== true) changes.push('embalagem v1 criada')
      } else {
        // produto com kits por cima: caixas por palete do sistema prevalecem sobre a planilha (salvo a opção)
        const kitProduct = Boolean(String(v?.attrs?.acessorio_sku ?? '').trim())
        if (kitProduct && !allowPalletChange && cur.unitsPerPallet != null && !same(cur.unitsPerPallet, pack.unitsPerPallet)) {
          rep.warnings.push(`${sku}: planilha com ${pack.unitsPerPallet ?? '—'} caixas/palete, o sistema tem ${cur.unitsPerPallet} (palete com os kits por cima) — MANTIDO ${cur.unitsPerPallet}. Corrija a planilha ou use --allow-pallet-change.`)
          pack.unitsPerPallet = cur.unitsPerPallet
        }
        const diff = (Object.keys(pack) as (keyof typeof pack)[]).filter((k) => !same(cur[k], pack[k]))
        if (diff.length) {
          changes.push(`embalagem (${diff.map((k) => `${k} ${cur[k]}→${pack[k]}`).join(', ')})`)
          if (cur.locked) {
            if (!dry) {
              await tx.update(s.packagingVersions).set({ validTo: today }).where(eq(s.packagingVersions.id, cur.id))
              const copy: Partial<typeof cur> = { ...cur }
              for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
              await tx.insert(s.packagingVersions).values({ ...(copy as typeof s.packagingVersions.$inferInsert), ...pack, allowedOrientations: oldDefault ? [...ORIENTATIONS] : cur.allowedOrientations, version: cur.version + 1, validFrom: today })
            }
            rep.newVersion.push(`${sku} v${cur.version + 1}`)
          } else if (!dry) {
            await tx.update(s.packagingVersions).set({ ...pack, ...(oldDefault ? { allowedOrientations: [...ORIENTATIONS] } : {}), updatedAt: new Date() }).where(eq(s.packagingVersions.id, cur.id))
          }
        } else if (oldDefault && !cur.locked) {
          if (!dry) await tx.update(s.packagingVersions).set({ allowedOrientations: [...ORIENTATIONS], updatedAt: new Date() }).where(eq(s.packagingVersions.id, cur.id))
        }
        if (oldDefault) rep.orientations++
      }
      if (rep.created.at(-1)?.startsWith(sku)) continue
      if (changes.length) rep.updated.push(`${sku}: ${changes.join(' · ')}`)
      else rep.unchanged++
    }
    // --deactivate-missing: o que não está na planilha sai do catálogo (não é apagado; cargas antigas intactas)
    if (deactivateMissing) {
      for (const sku of notInFile) {
        if (companionSkus.has(sku.toUpperCase())) continue
        const v = variants.find((x) => x.sku === sku)!
        if (!dry) await tx.update(s.productVariants).set({ active: false, updatedAt: new Date() }).where(eq(s.productVariants.id, v.id))
        rep.deactivated.push(sku)
      }
    }
    if (!dry) await tx.insert(s.auditLog).values({ entity: 'product_variant', entityId: null, action: 'import_catalog', diff: { file: file.split(/[\\/]/).pop(), created: rep.created.length, updated: rep.updated.length, reactivated: rep.reactivated, newVersion: rep.newVersion, renamed: rep.renamed, deactivated: rep.deactivated, linesRenamed: rep.linesRenamed, notInFile } })
  })
  if (!dry) await syncCompositionsWithCatalog(null)

  console.log(`${dry ? '[SIMULAÇÃO] ' : ''}Linhas no arquivo: ${rows.length}`)
  console.log(`\nRENOMEADOS (mesmo produto, código novo) (${rep.renamed.length}):\n  ${rep.renamed.join('\n  ')}`)
  console.log(`\nLINHAS RENOMEADAS: ${[...new Set(rep.linesRenamed)].join(', ') || '—'}`)
  console.log(`\nDESATIVADOS (não estão na planilha) (${rep.deactivated.length}): ${rep.deactivated.join(', ') || '—'}`)
  console.log(`\nNOVOS (${rep.created.length}):\n  ${rep.created.join('\n  ')}`)
  console.log(`\nALTERADOS (${rep.updated.length}):\n  ${rep.updated.join('\n  ')}`)
  console.log(`\nSem alteração: ${rep.unchanged}`)
  console.log(`Reativados: ${rep.reactivated.join(', ') || '—'}`)
  console.log(`Novas versões de embalagem (já usadas em cargas): ${rep.newVersion.join(', ') || '—'}`)
  console.log(`Embalagens que passam a orientação livre (antes só em pé por padrão): ${rep.orientations}`)
  console.log(`\nNo banco e NÃO no arquivo (não alterados): ${notInFile.join(', ') || '—'}`)
  if (rep.warnings.length) console.log(`\nAvisos:\n  ${rep.warnings.join('\n  ')}`)
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
