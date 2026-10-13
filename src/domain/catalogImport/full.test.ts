/**
 * Planilha oficial INTEIRA (667 linhas) — só roda com CATALOG_IMPORT_FULL_DIR apontando para uma pasta com
 * full-input.json ({ products: RawProductRow[], boxes: RawBoxRow[], current: CurrentCatalog }), gerado
 * fora do projeto a partir das planilhas e do catálogo local. Sem a variável, o teste é pulado.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRuleLona, lonaWidthM } from '@/domain/lonaRule'
import { cellDigits } from './cells'
import { eanStatusOf } from './ean'
import { buildImportPlan } from './plan'
import type { CurrentCatalog, FileInfo, RawBoxRow, RawProductRow } from './types'

const dir = process.env.CATALOG_IMPORT_FULL_DIR

describe.skipIf(!dir)('planilha oficial inteira', () => {
  const load = () => JSON.parse(fs.readFileSync(path.join(dir!, 'full-input.json'), 'utf8')) as { products: RawProductRow[]; boxes: RawBoxRow[]; current: CurrentCatalog }
  const fi = (name: string): FileInfo => ({ name, bytes: 0, sha256: '0'.repeat(64), sheetName: 'Planilha1', lastDataRow: 0, declaredRows: null })

  it('667 linhas, EAN, repetidos e resumo', () => {
    const input = load()
    const plan = buildImportPlan({ ...input, files: { products: fi('produtos.xlsx'), boxes: fi('caixas.xlsx') }, catalogFingerprint: 'full', now: new Date('2026-10-13T12:00:00Z') })
    const s = plan.summary
    expect(s.sheetRows).toBe(667)
    expect(s.parsedRows).toBe(667)
    expect(s.skippedRows).toBe(0)
    // EAN antes de descartar os repetidos: 636 EAN-13, 17 GTIN-14, 14 inválidos
    const st = input.products.map((r) => eanStatusOf(cellDigits(r.ean)).status)
    expect([st.filter((x) => x === 'EAN13').length, st.filter((x) => x === 'GTIN14').length, st.filter((x) => x === 'INVALID').length]).toEqual([636, 17, 14])
    expect(s.duplicateGroups).toBe(89)
    expect(s.duplicatesDiscarded).toBe(110)
    expect(s.planned).toBe(557)
    expect(plan.warnings.find((w) => w.code === 'DUPLICATES')?.message).toContain('20012 → 17018; 19489 → 17262; 19403 → 17474; 18145 → 17039; 17973/17129 → 16669; 17126 → 16670')
    expect(s.withPackaging + s.pending).toBe(s.planned)
    expect(plan.warnings.some((w) => w.level === 'BLOCKER')).toBe(false)
    expect(s.deactivations).toBe(input.current.variants.filter((v) => v.active && v.sku !== 'KIT-HF').length)
    // decisão 10: nenhum par de produtos com o mesmo nome (as duas séries de lona ficam em linhas diferentes)
    const names = plan.products.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
    // decisão 4: a exportação continua com Lona padrão
    const lonas = (prefix: string) => plan.products.filter((x) => x.name.startsWith(prefix) && isRuleLona(x.name) && (lonaWidthM(x.name) ?? 99) <= 14).length
    expect([lonas('Lona padrão'), lonas('Lona BPF'), lonas('Lona Plus')]).toEqual([38, 56, 3])
    // decisões 11 e 12; paletes que servem para a caixa (nada acima de 2.292 mm)
    const pk = (c: string) => plan.products.find((x) => x.code === c)?.packaging
    expect(pk('17822')).toMatchObject({ boxCode: '52185' })
    for (const c of ['19835', '19930', '19833', '19837']) expect(pk(c)).toMatchObject({ boxCode: '74645', palletTypeCode: 'PCF-1150-DUPLO', unitsPerPallet: 9 })
    for (const c of ['19595', '17379', '17298']) expect(pk(c)).toMatchObject({ palletTypeCode: 'PBR-1', unitsPerPallet: 8 })
    for (const c of ['19896', '19794', '17426']) expect(pk(c)).toMatchObject({ palletTypeCode: 'PCF-1100x1300', unitsPerPallet: 12 })
    expect(pk('17353')).toMatchObject({ palletTypeCode: 'PCF-1150', unitsPerPallet: 4 })
    expect(plan.products.filter((x) => (x.packaging?.palletHeightMm ?? 0) > 2292).map((x) => x.code)).toEqual([])
    expect(s).toMatchSnapshot()
  })
})
