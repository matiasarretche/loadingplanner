import { describe, expect, it } from 'vitest'
import { buildPriceTwins } from '@/domain/exportPricing'
import { allowedByLonaRule, isRuleLona, lonaWidthM } from '@/domain/lonaRule'
import { calcLengthM, perimeterFor, siloBagNetKg } from '@/domain/siloPerimeter'
import { buildBoxModels } from './boxSheet'
import { FIXTURE_BOX_ROWS, FIXTURE_CURRENT, FIXTURE_PRODUCT_ROWS, fixtureFile } from './fixtures'
import { buildImportPlan, DEFAULT_DECISIONS, ENGINE_VERSION } from './index'
import type { BuildPlanInput, CurrentCatalog, CurrentVariant, ImportPlan } from './types'

const input = (o: Partial<BuildPlanInput> = {}): BuildPlanInput => ({
  products: FIXTURE_PRODUCT_ROWS,
  boxes: FIXTURE_BOX_ROWS,
  current: FIXTURE_CURRENT,
  files: { products: fixtureFile('produtos.xlsx'), boxes: fixtureFile('caixas.xlsx') },
  catalogFingerprint: 'fp-1',
  now: new Date('2026-10-13T12:00:00Z'),
  ...o,
})
const plan = buildImportPlan(input())
const P = (code: string, pl: ImportPlan = plan) => {
  const p = pl.products.find((x) => x.code === code)
  if (!p) throw new Error(`${code} não está no plano`)
  return p
}
const pk = (code: string) => {
  const p = P(code).packaging
  if (!p) throw new Error(`${code} sem embalagem`)
  return p
}
const pend = (code: string) => plan.pending.find((x) => x.code === code)
const box = (code: string, row?: number) => plan.boxes.find((b) => b.code === code && (row == null || b.sheetRow === row))!

describe('plano: cabeçalho e invariantes', () => {
  it('versão do motor, decisões, arquivos e data', () => {
    expect(plan.engineVersion).toBe(ENGINE_VERSION)
    expect(plan.decisionsId).toBe(DEFAULT_DECISIONS.id)
    expect(plan.generatedAt).toBe('2026-10-13T12:00:00.000Z')
    expect(plan.catalogFingerprint).toBe('fp-1')
  })
  it('com caixa + pendentes = planejados; toda embalagem com 6 orientações, comprimento ≥ largura e 1 unidade', () => {
    const s = plan.summary
    expect(s.withPackaging + s.pending).toBe(s.planned)
    expect(plan.pending).toHaveLength(s.pending)
    // + os produtos fora da planilha (decisão extraProducts)
    expect(s.planned + s.duplicatesDiscarded).toBe(s.parsedRows + DEFAULT_DECISIONS.extraProducts.length)
    for (const p of plan.products) {
      if (!p.packaging) {
        expect(pend(p.code)).toBeTruthy()
        continue
      }
      expect(p.packaging.allowedOrientations).toEqual(['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'])
      expect(p.packaging.lengthMm).toBeGreaterThanOrEqual(p.packaging.widthMm)
      expect(p.packaging.unitsPerPackage).toBe(1)
      expect(p.packaging.grossKg).toBeGreaterThan(p.packaging.netKg)
      expect(pend(p.code)).toBeUndefined()
    }
  })
  it('é determinístico', () => {
    expect(JSON.stringify(buildImportPlan(input()))).toBe(JSON.stringify(plan))
  })
  it('SKU = código oficial em texto (ou o SKU dado ao produto fora da planilha); atributos só texto ou número', () => {
    const extras = new Set(DEFAULT_DECISIONS.extraProducts.map((x) => x.sku))
    for (const p of plan.products) {
      expect(p.code).toMatch(extras.has(p.code) ? /^SB-PAC-/ : /^\d{5}$/)
      for (const v of Object.values(p.attrs)) expect(v === null || typeof v === 'string' || typeof v === 'number').toBe(true)
    }
  })
})

describe('EAN', () => {
  it('estado e motivo', () => {
    expect(P('14412')).toMatchObject({ ean: '7898557300178', eanStatus: 'EAN13' })
    expect(P('18098').eanStatus).toBe('GTIN14')
    expect(P('17712')).toMatchObject({ ean: '17898557308256', eanStatus: 'GTIN14' })
    expect(P('19522')).toMatchObject({ ean: '789855730389', eanStatus: 'INVALID', eanNote: '12 dígitos' })
    expect(P('17827')).toMatchObject({ eanStatus: 'INVALID', eanNote: '11 dígitos' })
    expect(P('19379').eanStatus).toBe('INVALID')
    expect(P('19379').eanNote).toMatch(/esperado 789855830365\d.*7898557/)
    expect(plan.warnings.find((w) => w.code === 'EAN_INVALID')?.codes).toEqual(expect.arrayContaining(['19522', '17827', '19379']))
    expect(plan.warnings.find((w) => w.code === 'GTIN14')?.codes).toEqual(expect.arrayContaining(['18098', '17712']))
  })
})

describe('leitura das medidas', () => {
  it('silo-bolsa em pés: comprimento em pés e metros, MIL em µm', () => {
    expect(P('19983')).toMatchObject({ diameterFt: 12, lengthFt: 500, lengthM: 152.4, thicknessUm: 254, name: 'Silo-bolsa 12 pés × 500 pés (152,4 m) × 254 µm' })
  })
  it('Hidrosilo em pés / gauge e de filme aberto', () => {
    expect(P('17677').thicknessUm).toBe(600)
    expect(P('17677').widthM).toBeCloseTo(2, 2)
    expect(P('20027')).toMatchObject({ widthM: 2.15, attrs: { largura_filme_m: 4.3, valvulas: 4 } })
    expect(P('19790').widthM).toBe(3)
    expect(P('17679')).toMatchObject({ thicknessUm: 508, name: 'Hidrosilo 2,13 × 10,67 m (7 × 35 pés) × 508 µm 4V' })
  })
})

describe('classificação e nomes (decisões 3, 4, 5, 6)', () => {
  it('filmes, acessórios, Hidropeso e bolsas para silagem', () => {
    expect(P('18054')).toMatchObject({ family: 'FILM_ROLL', lineKey: 'FILM_BPF', productLine: 'Filme BPF', name: 'Filme BPF 1,5 × 600 m × 40 µm', attrs: { formato: 'rolo' } })
    expect(P('18135')).toMatchObject({ family: 'FILM_ROLL', lineKey: 'FILM_BIGSAFE', name: 'Filme BigSafe 8 × 150 m × 50 µm (natural)' })
    for (const c of ['76794', '17712', '17416']) expect(P(c)).toMatchObject({ family: 'ACCESSORY', brand: 'Pacifil' })
    expect(P('76794').name).toBe('Fita de butil 41 × 35 cm')
    expect(P('17712').name).toBe('Caixa de fitas PE silo-bolsa 41 cm × 5 m branca — c/10 un')
    expect(P('17416').name).toBe('Adesivo de reparo Hidrosilo em PVC 25 × 25 cm')
    expect(P('17751')).toMatchObject({ family: 'HIDROPESO', name: 'Hidropeso 1,5 × 0,3 m × 500 µm' })
    expect(P('17607')).toMatchObject({ family: 'SILAGE_BAG', name: 'Bolsa para silagem 2 × 3 m × 125 µm — caixa c/50 un' })
  })
  it('lonas: grupo BPF e SBG em metros = Lona padrão (exportação), "BPF 8X50" do grupo SILO PLASTICO/RESERV = Lona BPF, BPF PLUS = Lona Plus, multicamadas = BigSafe', () => {
    expect(P('19712')).toMatchObject({ lineKey: 'TARP_STD', productLine: 'Lona padrão', name: 'Lona padrão 8 × 50 m × 150 µm (natural)', attrs: { acabamento: 'natural', formato: 'rolo' } })
    expect(P('19771')).toMatchObject({ lineKey: 'TARP_STD', productLine: 'Lona padrão', name: 'Lona padrão 8 × 100 m × 120 µm' })
    expect(P('19894')).toMatchObject({ lineKey: 'TARP_PLUS', productLine: 'Lona Plus (LP)', name: 'Lona Plus 14 × 50 m × 120 µm' })
    expect(P('19867').name).toBe('Lona BPF Ecobag 8 × 50 m × 110 µm')
    // as duas séries de mesma medida e peso (aberta × tubular) ficam em linhas diferentes, com nomes diferentes
    expect(P('14412')).toMatchObject({ lineKey: 'TARP_BPF', productLine: 'Lona BPF', name: 'Lona BPF 8 × 50 m × 125 µm' })
    expect(P('19675')).toMatchObject({ lineKey: 'TARP_STD', productLine: 'Lona padrão', name: 'Lona padrão 8 × 50 m × 125 µm' })
    expect(P('17774')).toMatchObject({ productLine: 'Lona BigSafe', name: 'Lona BigSafe 16 × 50 m × 125 µm' })
    expect(P('17765')).toMatchObject({ family: 'SILAGE_TARP', productLine: 'Lona BigSafe', name: 'Lona BigSafe 2,3 × 100 m × 240 µm' })
    expect(P('19934').name).toBe('Lona Big Silo Plus X3 24 × 50 m × 125 µm')
    expect(P('19524').name).toBe('Lona barreira O2 (PA) 10 × 50 m × 125 µm (poliamida)')
    expect(P('18327')).toMatchObject({ lineKey: 'TARP_BPF_BP', name: 'Lona BPF B/P 15 × 50 m × 100 µm' })
    expect(P('19916')).toMatchObject({ lineKey: 'TARP_BPF_PLUSX3', name: 'Lona BPF Plus X3 10 × 100 m × 125 µm' })
  })
  it('os nomes continuam funcionando com a regra das lonas', () => {
    expect(isRuleLona(P('19712').name)).toBe(true)
    expect(lonaWidthM(P('19867').name)).toBe(8)
    expect(allowedByLonaRule(P('19712').name, 'EXPORT')).toBe(true)
    expect(allowedByLonaRule(P('19771').name, 'EXPORT')).toBe(true)
    expect(allowedByLonaRule(P('19675').name, 'EXPORT')).toBe(true)
    expect(allowedByLonaRule(P('14412').name, 'EXPORT')).toBe(false)
    expect(allowedByLonaRule(P('14412').name, 'DOMESTIC')).toBe(true)
    expect(isRuleLona(P('17774').name)).toBe(false)
  })
  it('silo-bolsa e reservatórios no formato atual; EXT. B vira Pacifil', () => {
    expect(P('19924').name).toBe('Silo-bolsa 9 pés × 75 m × 208 µm')
    expect(P('19950').name).toBe('Silo-bolsa Ecobag 9 pés × 75 m × 200 µm')
    // sigla de espessura da fábrica (BPT / BBT / BPM) fora do nome: a espessura já está na medida (Matías, 14/10/2026)
    expect(P('17303').name).toBe('Silo-bolsa 6 pés × 100 m × 160 µm')
    expect(P('18060')).toMatchObject({ brand: 'Pacifil', name: 'Hidrosilo 2 × 3 m × 600 µm — 2.000 L' })
    expect(P('18010').name).toBe('Hidrosilo 2 × 50 m × 600 µm — 50.000 L')
    expect(P('20027').name).toBe('Hidrosilo 2,15 × 20 m × 500 µm 4V (filme 4,3 m)')
  })
})

describe('repetidos (decisão 10)', () => {
  it('fica o código mais recente com dados bons; os outros são descartados', () => {
    const kept = (c: string) => plan.products.some((x) => x.code === c)
    const discardedFor = (c: string) => plan.discarded.find((x) => x.code === c)?.keptCode
    for (const c of ['18060', '16670', '16669', '19646', '17018', '17765', '18020']) expect(kept(c)).toBe(true)
    expect(discardedFor('17990')).toBe('18060')
    expect(discardedFor('17126')).toBe('16670')
    expect(discardedFor('17973')).toBe('16669')
    expect(discardedFor('17129')).toBe('16669')
    expect(discardedFor('20012')).toBe('17018')
    expect(discardedFor('17399')).toBe('17765')
    expect(discardedFor('18006')).toBe('18020')
    expect(discardedFor('17137')).toBe('19646')
    expect(plan.discarded.find((x) => x.code === '20012')?.reason).toContain('bruto igual ao líquido')
    expect(plan.summary.duplicatesDiscarded).toBe(plan.discarded.length)
  })
  it('o mesmo produto escrito de outro jeito também é repetido ("600MIC" × "600 MICRAS", "09PES" × "9PES", "235MIC" × "9.25MIL", "125MIC" × "125 MICRAS")', () => {
    const discardedFor = (c: string) => plan.discarded.find((x) => x.code === c)
    for (const [c, kept] of [
      ['17500', '19924'],
      ['17321', '18010'],
      ['19325', '19745'],
      ['17240', '17774'],
      ['17308', '18020'],
    ])
      expect(discardedFor(c)?.keptCode).toBe(kept)
    expect(discardedFor('17500')?.reason).toContain('escrito de outro jeito')
  })
  it('lona do grupo SBG (erro de cadastro) é repetido da Lona padrão igual do grupo BPF: fica o código mais recente', () => {
    expect(plan.discarded.find((x) => x.code === '17367')).toMatchObject({ keptCode: '19771' })
    expect(plan.discarded.find((x) => x.code === '17367')?.reason).toContain('outro grupo da planilha')
  })
  it('as duas séries de lona (grupo BPF × "BPF 8X50") NÃO são repetidos: as duas ficam, com nomes diferentes', () => {
    expect(P('19675').name).not.toBe(P('14412').name)
    expect(P('19675').packaging?.netKg).toBeCloseTo(P('14412').packaging!.netKg, 0)
  })
  it('nenhum par de produtos planejados com o mesmo nome', () => {
    const names = plan.products.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('tabela de caixas', () => {
  it('medidas com comprimento ≥ largura, correção do 77290 e tara K+L+M', () => {
    expect(box('72786', 2)).toMatchObject({ lengthMm: 600, widthMm: 500, heightMm: 130, tareKg: 1.1 })
    expect(box('72786', 45)).toMatchObject({ lengthMm: 600, widthMm: 500, heightMm: 130, tareKg: 2.284, palletTypeCode: 'PCF-1150', boxesPerPallet: 60 })
    expect(box('77290', 51)).toMatchObject({ lengthMm: 2250, widthMm: 380, heightMm: 310 })
    expect(box('69491')).toMatchObject({ tareKg: 6.96 })
    expect(box('69491').tareNote).toContain('6,7')
  })
  it('palete "2,00X1,20" = palete duplo; caixas por palete: o maior número', () => {
    expect(box('74645')).toMatchObject({ palletText: '2,00X1,20', palletTypeCode: 'PCF-1150-DUPLO', boxesPerPallet: 9, ignoreWeightRange: true })
    expect(box('69496').boxesPerPallet).toBe(26)
    expect(box('69493').boxesPerPallet).toBe(14)
    expect(box('72543').boxesPerPallet).toBe(12)
    expect(box('72444').boxesPerPallet).toBe(6)
    expect(box('69497').boxesPerPallet).toBe(3)
    expect(box('76367', 38).boxesPerPallet).toBe(4)
  })
  it('fila sem código (oculta) fica de fora; todas as outras reconhecidas', () => {
    expect(plan.boxes).toHaveLength(49)
    expect(plan.boxes.every((b) => b.recognized)).toBe(true)
    expect(plan.boxes.some((b) => b.sheetRow === 11)).toBe(false)
    expect(plan.warnings.some((w) => w.code === 'BOX_ROW_NO_CODE')).toBe(true)
  })
  it('referência desconhecida: aviso e nunca atribuída', () => {
    const rows = FIXTURE_BOX_ROWS.map((r) => (r.row === 20 ? { ...r, reference: '9X75 NOVA' } : r))
    const { boxes, warnings } = buildBoxModels(rows, DEFAULT_DECISIONS)
    expect(boxes.find((b) => b.sheetRow === 20)).toMatchObject({ recognized: false, family: null })
    expect(warnings.some((w) => w.code === 'UNRECOGNIZED_BOX_ROW')).toBe(true)
    const pl = buildImportPlan(input({ boxes: rows }))
    expect(pl.products.some((x) => x.packaging?.boxSheetRow === 20)).toBe(false)
  })
})

describe('pesos (decisão 7)', () => {
  it('bruto oficial quando plausível, senão líquido + tara da caixa', () => {
    expect(pk('19983')).toMatchObject({ boxCode: '69497', netKg: 420, grossKg: 437.45, grossSource: 'NET_PLUS_BOX_TARE' })
    expect(pk('19924')).toMatchObject({ boxCode: '69490', netKg: 126.49, grossKg: 133, grossSource: 'NET_PLUS_BOX_TARE' })
    expect(pk('19924').grossNote).toContain('132,75')
    expect(pk('17341')).toMatchObject({ grossSource: 'NET_PLUS_BOX_TARE', grossKg: 53.73 })
    expect(pk('17341').grossNote).toContain('absurdo')
  })
})

describe('caixas atribuídas (decisões 11–18 e verificação)', () => {
  it('lonas', () => {
    // a caixa segue a linha da tabela de caixas: fila "BPF 4X100, 8X50" (69496) = Lona BPF; fila sem linha (75913) = Lona padrão
    expect(pk('14412')).toMatchObject({ boxCode: '69496', confidence: 'HIGH', palletTypeCode: 'PBR-1', unitsPerPallet: 20, palletSource: 'CATALOG' })
    expect(pk('19675')).toMatchObject({ boxCode: '75913', confidence: 'HIGH', palletTypeCode: 'PBR-1', unitsPerPallet: 20, palletSource: 'CATALOG' })
    expect(pk('19712')).toMatchObject({ boxCode: '69493', palletTypeCode: 'PBR-1', unitsPerPallet: 12 })
    expect(P('19712').match?.sku).toBe('LS-PAC-8X50-150-STD')
    // Lona padrão 10 × 50 × 125 (58 kg) passa da faixa da fila padrão: caixa da fila BPF, confiança média
    expect(pk('19676')).toMatchObject({ boxCode: '69493', confidence: 'MEDIUM' })
    expect(pk('14413')).toMatchObject({ boxCode: '70328', confidence: 'MEDIUM' })
    expect(pk('17774')).toMatchObject({ boxCode: '74645', lengthMm: 1600, widthMm: 364, heightMm: 337, confidence: 'HIGH', palletTypeCode: 'PCF-1150-DUPLO', unitsPerPallet: 9 })
    // Lona padrão 8 × 50 × 200 µm (75 kg): a fila padrão não tem caixa para esse peso → pendente
    expect(P('19655').packaging).toBeNull()
    expect(pend('19655')).toBeDefined()
    expect(pk('17759').boxCode).toBe('69499')
  })
  it('Big Silo 18 × 50 m: caixa 74645 no palete duplo, como o 16 e o 20 × 50 (decisão 12), mesmo com o equivalente na caixa 72543', () => {
    for (const c of ['19835', '19930']) {
      expect(P(c).match?.sku).toBe('LS-PAC-18X50-125-ESP')
      expect(pk(c)).toMatchObject({ boxCode: '74645', lengthMm: 1600, widthMm: 364, heightMm: 337, palletTypeCode: 'PCF-1150-DUPLO', unitsPerPallet: 9, palletSource: 'SHEET' })
      expect(pk(c).palletNote).toContain('não cabe no palete PCF-1100x1300')
    }
  })
  it('lonas pendentes com a sugestão da verificação', () => {
    expect(P('19658').packaging).toBeNull()
    expect(pend('19658')?.suggestion?.boxCode).toBe('70328')
    for (const c of ['19672', '19659', '19771']) expect(pend(c)?.suggestion?.boxCode).toBe('70328')
    expect(pend('19672')?.reasonCode).toBe('TARP_OVER_100KG')
    expect(pend('19916')?.reasonCode).toBe('TARP_OVER_100KG')
    expect(pend('17446')).toMatchObject({ reasonCode: 'PACK_UNITS', unitsPerPackHint: 3 })
  })
  it('silo-bolsas', () => {
    expect(pk('19924').boxCode).toBe('69490')
    expect(pk('19924').notes.join(' ')).toContain('caixa muda (atual 1000×600×400')
    expect(pk('17599')).toMatchObject({ boxCode: '52185', lengthMm: 550, widthMm: 500, heightMm: 400 })
    expect(pk('17994')).toMatchObject({ boxCode: '74043', confidence: 'HIGH', palletTypeCode: 'PCF-1150', unitsPerPallet: 6 })
    expect(pk('17293')).toMatchObject({ boxCode: '69491', confidence: 'HIGH' })
    // faixa de peso da linha antes da caixa da medida (219,8 kg: 12X75 176–230 kg, não 9X125 231–260 kg)
    expect(pk('19763')).toMatchObject({ boxCode: '69495', confidence: 'MEDIUM' })
    for (const c of ['19611', '17303']) expect(pend(c)).toMatchObject({ reasonCode: 'SILO_BAG_WEIGHT_GAP', suggestion: { boxCode: '69488' } })
    expect(P('19611').attrs.caixa_sugerida).toBe('69488')
    // decisão 11: Probag 6 pés sem fila própria → 52185 da linha irmã STD, mesmo com a tara oficial ruim (decisão 7)
    expect(pk('17822')).toMatchObject({ boxCode: '52185', confidence: 'MEDIUM', grossSource: 'NET_PLUS_BOX_TARE', grossKg: 54.79 })
  })
  it('palete do catálogo só quando serve para a caixa planejada (sem "torres")', () => {
    // 10 pés × 75 m: caixa nova 69491 (1000 × 600) no PCF-1150 do catálogo daria 1 por camada × 8 (4 m): vale o PBR-1 × 8 da tabela
    expect(P('19595').match?.sku).toBe('SB-PAC-10X75-254')
    expect(pk('19595')).toMatchObject({ boxCode: '69491', palletTypeCode: 'PBR-1', unitsPerPallet: 8, palletSource: 'SHEET', palletHeightMm: 2097 })
    expect(pk('19595').palletNote).toContain('2 → 1 por camada')
    // 18 × 40 m: caixa 72543 (1100 × 650) no PBR-1 daria 1 por camada × 10: vale o PCF-1100x1300 × 12 ("10 e 12")
    expect(pk('19896')).toMatchObject({ boxCode: '72543', palletTypeCode: 'PCF-1100x1300', unitsPerPallet: 12, palletSource: 'SHEET' })
    // 14 pés × 100 m: caixa de 750 mm com as 6 un. do catálogo = 2.400 mm (acima de 2.292): vale o × 4 da tabela
    expect(pk('17353')).toMatchObject({ boxCode: '69498', palletTypeCode: 'PCF-1150', unitsPerPallet: 4, palletSource: 'SHEET' })
    // com a mesma caixa e um palete que cabe, o do catálogo continua prevalecendo
    expect(pk('17994')).toMatchObject({ palletSource: 'CATALOG', palletTypeCode: 'PCF-1150', unitsPerPallet: 6 })
    for (const x of plan.products) if (x.packaging?.palletHeightMm != null) expect(x.packaging.palletHeightMm).toBeLessThanOrEqual(2292)
    expect(plan.warnings.find((w) => w.code === 'PALLET_FROM_SHEET')?.codes).toEqual(expect.arrayContaining(['19595', '19896', '17353', '19835', '19930']))
    expect(plan.warnings.some((w) => w.code === 'PALLET_TOO_TALL')).toBe(false)
  })
  it('Hidrosilo / Hidroforce', () => {
    expect(pk('18137')).toMatchObject({ boxSource: 'CURRENT_CATALOG', boxCode: null, lengthMm: 1140, widthMm: 570, heightMm: 180, palletTypeCode: 'PCF-1150', unitsPerPallet: 22, confidence: 'MEDIUM' })
    expect(P('18137').attrs.capacidade_l).toBe(10000)
    expect(pk('17657')).toMatchObject({ boxCode: '77290', widthMm: 380, confidence: 'MEDIUM' })
    expect(pk('18010')).toMatchObject({ boxCode: '77290', palletTypeCode: 'PCF-1150-DUPLO', unitsPerPallet: 18 })
    expect(pk('18074')).toMatchObject({ boxCode: '79582', palletTypeCode: 'PCF-1150', unitsPerPallet: 26 })
    expect(P('18074').attrs).toMatchObject({ acessorio_sku: 'KIT-HF', acessorio_qtd: 1 })
    expect(pk('18141')).toMatchObject({ boxCode: '72786', lengthMm: 600, widthMm: 500, heightMm: 130 })
    expect(P('18141').attrs.capacidade_l).toBe(500)
    expect(pend('18098')).toMatchObject({ reasonCode: 'PACK_UNITS', unitsPerPackHint: 4 })
    expect(pend('19790')?.reasonCode).toBe('NO_BOX_RULE')
  })
  it('sem caixa: bolsas para silagem, filmes, acessórios, Hidropeso, sem peso', () => {
    expect(pend('17607')).toMatchObject({ reasonCode: 'SILAGE_BAG', unitsPerPackHint: 50 })
    expect(pend('18054')?.reasonCode).toBe('FILM')
    expect(pend('76794')?.reasonCode).toBe('ACCESSORY')
    expect(pend('17751')?.reasonCode).toBe('HIDROPESO')
    expect(pend('17416')?.reasonCode).toBe('NO_NET_WEIGHT')
  })
  it('caixa da tabela vira atributo codigo_caixa; verificado só com a mesma caixa e o mesmo peso', () => {
    expect(P('14412').attrs.codigo_caixa).toBe('69496')
    expect(P('19675').attrs.codigo_caixa).toBe('75913')
    expect(P('18137').attrs.codigo_caixa).toBeUndefined()
    expect(pk('18137').verification).toBe('VERIFIED')
    expect(pk('18010').verification).toBe('VERIFIED')
    expect(pk('19924').verification).toBe('ESTIMATED')
  })
})

describe('equivalentes no catálogo atual', () => {
  it('correções V.2.2 e V.3 sem exceções por código', () => {
    expect(P('16670').match).toMatchObject({ sku: 'SB-PAC-9X75-254' })
    expect(P('16669').match).toMatchObject({ sku: 'SB-PAC-9X60-254' })
    expect(P('14412').match).toMatchObject({ sku: 'LS-PAC-8X50-125-BPF', confidence: 'HIGH', lineRelation: 'SAME' })
    expect(P('14412').attrs.codigo_anterior).toBe('LS-PAC-8X50-125-BPF')
    expect(P('19675').match).toMatchObject({ sku: 'LS-PAC-8X50-125-STD', confidence: 'HIGH', lineRelation: 'SAME' })
    expect(P('17765').match).toMatchObject({ sku: 'AC-PAC-2.3X100-240', lineRelation: 'COMPATIBLE' })
  })
  it('tudo é criado com o código novo; os atuais saem, menos o KIT-HF e os silo-bolsas 6 pés mantidos por decisão', () => {
    const active = FIXTURE_CURRENT.variants.filter((v) => v.active).map((v) => v.sku)
    const kept = ['KIT-HF', 'SB-PAC-6X75-180', 'SB-PAC-6X100-180']
    expect(plan.summary.toCreate).toBe(plan.summary.planned)
    expect(plan.deactivations.variants.map((v) => v.sku).sort()).toEqual(active.filter((s) => !kept.includes(s)).sort())
    expect(plan.deactivations.keptActive.map((k) => k.sku)).toEqual(kept)
    expect(plan.deactivations.keptActive.find((k) => k.sku === 'SB-PAC-6X100-180')?.reason).toContain('fora da planilha oficial')
    // o recorte do catálogo não tem o 6 × 75: avisado
    expect(plan.warnings.find((w) => w.code === 'KEEP_ACTIVE_MISSING')?.codes).toEqual(['SB-PAC-6X75-180'])
    expect(plan.deactivations.variants.find((v) => v.sku === 'LS-PAC-8X50-125-BPF')?.replacedBy).toContain('14412')
    // a Lona padrão 8 × 50 × 125 tem substituto na Lona padrão (grupo BPF); as medidas que a planilha só tem
    // como "BPF 4X100…" (Lona BPF, mercado interno) ficam sem substituto e entram no aviso da prévia
    expect(plan.deactivations.variants.find((v) => v.sku === 'LS-PAC-8X50-125-STD')?.replacedBy).toContain('19675')
    const noRepl = plan.warnings.find((w) => w.code === 'LONA_EXPORT_NO_REPLACEMENT')?.codes ?? []
    for (const sku of ['LS-PAC-4X100-125-STD', 'LS-PAC-6X25-125-STD', 'LS-PAC-12X50-125-STD']) {
      expect(plan.deactivations.variants.find((v) => v.sku === sku)?.replacedBy).toEqual([])
      expect(noRepl).toContain(sku)
    }
  })
})

describe('famílias, linhas e avisos', () => {
  it('Filmes em rolo e Hidropeso são criadas; Animal Comfort fica vazia', () => {
    const f = (k: string) => plan.families.find((x) => x.key === k)
    expect(f('FILM_ROLL')).toMatchObject({ code: 'FILM_ROLL', name: 'Filmes em rolo', action: 'CREATE' })
    expect(f('HIDROPESO')).toMatchObject({ code: 'HIDROPESO', name: 'Hidropeso', action: 'CREATE' })
    expect(f('FILM_ROLL')!.sort).toBeGreaterThan(Math.max(...FIXTURE_CURRENT.families.map((x) => x.sort)))
    expect(f('SILAGE_TARP')).toMatchObject({ action: 'EXISTS' })
    expect(plan.summary.familiesWithoutActiveProducts).toEqual(['Animal Comfort'])
    expect(plan.lines.find((l) => l.name === 'Lona BPF')?.action).toBe('EXISTS')
    expect(plan.lines.find((l) => l.name === 'Lona BPF Plus X3')?.action).toBe('CREATE')
  })
  it('avisos', () => {
    const codes = plan.warnings.map((w) => w.code)
    expect(codes).toEqual(expect.arrayContaining(['DUPLICATES', 'GROSS_REPLACED', 'HF_COMPANION', 'FAMILY_EMPTY', 'PALLET_FROM_SHEET', 'LONA_EXPORT_NO_REPLACEMENT']))
    expect(codes).not.toContain('LONA_RULE_EXPORT')
    expect(plan.warnings.some((w) => w.level === 'BLOCKER')).toBe(false)
    // Lonas padrão do catálogo atual cuja medida só existe na planilha como "BPF 4X100…" (Lona BPF): avisado na prévia
    expect(plan.warnings.find((w) => w.code === 'LONA_EXPORT_NO_REPLACEMENT')?.codes).toContain('LS-PAC-4X100-125-STD')
    expect(plan.warnings.find((w) => w.code === 'LONA_EXPORT_NO_REPLACEMENT')?.codes).not.toContain('LS-PAC-8X50-150-STD')
  })
  it('as duas séries de lona na mesma linha (exportação sem Lona padrão) bloqueiam a importação', () => {
    const d = { ...DEFAULT_DECISIONS, tarpGroupLine: { ...DEFAULT_DECISIONS.tarpGroupLine, 'SILO PLAS/RESERV BPF': 'TARP_BPF' as const } }
    const pl = buildImportPlan(input({ decisions: d }))
    expect(pl.warnings.find((w) => w.code === 'LONA_RULE_EXPORT')).toMatchObject({ level: 'BLOCKER' })
  })
  it('palete inexistente no programa bloqueia', () => {
    const current: CurrentCatalog = { ...FIXTURE_CURRENT, palletTypes: FIXTURE_CURRENT.palletTypes.filter((p) => p.code !== 'PCF-1150-DUPLO') }
    const pl = buildImportPlan(input({ current }))
    expect(pl.warnings.find((w) => w.code === 'PALLET_TYPE_MISSING')).toMatchObject({ level: 'BLOCKER' })
  })
  it('código repetido na planilha bloqueia', () => {
    const pl = buildImportPlan(input({ products: [...FIXTURE_PRODUCT_ROWS, { ...FIXTURE_PRODUCT_ROWS[0], row: 999, measure: '20CM X 15CM' }] }))
    expect(pl.warnings.find((w) => w.code === 'DUPLICATE_CODE')).toMatchObject({ level: 'BLOCKER' })
  })
  it('as séries podem ser invertidas mudando a decisão (grupo BPF = Lona BPF, "BPF 8X50" = Lona padrão)', () => {
    const d = { ...DEFAULT_DECISIONS, tarpGroupLine: { ...DEFAULT_DECISIONS.tarpGroupLine, 'SILO PLAS/RESERV BPF': 'TARP_BPF' as const, namedBpfPrefix: 'TARP_STD' as const } }
    const pl = buildImportPlan(input({ decisions: d }))
    expect(P('19712', pl)).toMatchObject({ lineKey: 'TARP_BPF', name: 'Lona BPF 8 × 50 m × 150 µm (natural)' })
    expect(P('14412', pl)).toMatchObject({ lineKey: 'TARP_STD', name: 'Lona padrão 8 × 50 m × 125 µm' })
    expect(P('14412', pl).match).toMatchObject({ sku: 'LS-PAC-8X50-125-STD', lineRelation: 'SAME' })
    // invertido, a lona do grupo SBG já não cai na linha do grupo BPF: as duas 8 × 100 × 120 ficam (nomes diferentes)
    expect(pl.discarded.find((x) => x.code === '17367')).toBeUndefined()
    expect(pl.warnings.some((w) => w.level === 'BLOCKER')).toBe(false)
  })
})

describe('preço do Hidrosilo 3 m', () => {
  it('o 3 m de 10.000 L encontra um 2 m de 10.000 L entre os planejados', () => {
    const items = plan.products
      .filter((x) => x.family === 'HIDROSILO' || x.family === 'HYDROFORCE')
      .map((x) => ({ sku: x.code, family: x.family === 'HIDROSILO' ? 'Hidrosilo' : 'Hidroforce', brand: x.brand, widthM: x.widthM, capacityL: typeof x.attrs.capacidade_l === 'number' ? x.attrs.capacidade_l : null, netKg: x.packaging?.netKg ?? x.source.netKg, active: true }))
    const twin = buildPriceTwins(items).get('18137')
    expect(twin).toBeTruthy()
    const ref = P(twin!.sku)
    expect(ref).toMatchObject({ widthM: 2, attrs: { capacidade_l: 10000 } })
  })
})

describe('reimportação (mesmo código)', () => {
  // catálogo "depois de aplicar": os planejados viram variantes atuais com a embalagem planejada
  const after: CurrentVariant[] = plan.products.map((x, i) => ({
    variantId: 5000 + i,
    productId: 1,
    sku: x.code,
    name: x.name,
    familyCode: DEFAULT_DECISIONS.families[x.family].code,
    familyName: DEFAULT_DECISIONS.families[x.family].name,
    line: x.productLine,
    brand: x.brand,
    active: true,
    thicknessUm: x.thicknessUm,
    diameterFt: x.diameterFt,
    widthM: x.widthM,
    lengthM: x.lengthM,
    lengthFt: x.lengthFt,
    attrs: x.attrs,
    ean: x.ean,
    pack: x.packaging
      ? { packagingVersionId: 9000 + i, version: 1, locked: false, lengthMm: x.packaging.lengthMm, widthMm: x.packaging.widthMm, heightMm: x.packaging.heightMm, netKg: x.packaging.netKg, grossKg: x.packaging.grossKg, unitsPerPackage: 1, unitsPerPallet: x.packaging.unitsPerPallet, palletTypeCode: x.packaging.palletTypeCode, verification: x.packaging.verification }
      : null,
  }))
  const old = FIXTURE_CURRENT.variants.map((v) => ({ ...v, active: v.sku === 'KIT-HF' }))
  const again = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...after] } }))
  it('tudo vira atualização pelo código, nada é desativado e o palete do catálogo prevalece', () => {
    expect(again.summary.toUpdate).toBe(plan.summary.planned)
    expect(again.summary.toCreate).toBe(0)
    expect(again.deactivations.variants).toHaveLength(0)
    for (const x of again.products) {
      expect(x.match?.lineRelation).toBe('EXACT_CODE')
      expect(x.existingVariantId).toBeGreaterThanOrEqual(5000)
      const before = P(x.code).packaging
      if (!before) continue
      expect(x.packaging?.palletSource).toBe('CATALOG')
      expect(x.packaging?.unitsPerPallet).toBe(before.unitsPerPallet)
      expect([x.packaging?.lengthMm, x.packaging?.widthMm, x.packaging?.heightMm]).toEqual([before.lengthMm, before.widthMm, before.heightMm])
    }
    expect(P('14412', again).attrs.codigo_anterior).toBe('LS-PAC-8X50-125-BPF')
  })
  it('reimportar sobre um palete gravado errado (mesma caixa) corrige pelo da tabela', () => {
    // como a importação anterior gravou 19595: caixa 69491 no PCF-1150 × 8 (1 por camada × 8 = 4 m)
    const bad = after.map((v) => (v.sku === '19595' && v.pack ? { ...v, pack: { ...v.pack, palletTypeCode: 'PCF-1150', unitsPerPallet: 8 } } : v))
    const fixed = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...bad] } }))
    expect(P('19595', fixed).packaging).toMatchObject({ boxCode: '69491', palletTypeCode: 'PBR-1', unitsPerPallet: 8, palletSource: 'SHEET' })
    expect(P('19595', fixed).packaging?.palletNote).toContain('não serve com a caixa 69491')
  })
})

describe('produtos fora da planilha (decisão extraProducts, 14/10/2026)', () => {
  it('silo-bolsas 10 pés × 100 m e × 60 m × 235 µm: mesmo motor (nome, linha, caixa), SKU dado e peso estimado nas observações', () => {
    expect(P('SB-PAC-10X100-235')).toMatchObject({ action: 'CREATE', family: 'SILO_BAG', lineKey: 'SB_STD', brand: 'Pacifil', name: 'Silo-bolsa 10 pés × 100 m × 235 µm', diameterFt: 10, lengthM: 100, thicknessUm: 235 })
    expect(P('SB-PAC-10X60-235')).toMatchObject({ name: 'Silo-bolsa 10 pés × 60 m × 235 µm', lengthM: 60 })
    expect(pk('SB-PAC-10X100-235')).toMatchObject({ netKg: 213.2, boxCode: '74043', grossSource: 'NET_PLUS_BOX_TARE' })
    expect(pk('SB-PAC-10X60-235').netKg).toBe(127.9)
    for (const c of ['SB-PAC-10X100-235', 'SB-PAC-10X60-235']) expect(P(c).dataIssues.join(' ')).toContain('peso líquido ESTIMADO')
    expect(plan.warnings.find((w) => w.code === 'EXTRA_PRODUCTS')).toMatchObject({ level: 'INFO', codes: ['SB-PAC-10X100-235', 'SB-PAC-10X60-235'] })
    expect(plan.summary.parsedRows).toBe(FIXTURE_PRODUCT_ROWS.length)
  })
  it('se a planilha passar a ter o mesmo produto, fica o código da fábrica', () => {
    const official = { ...FIXTURE_PRODUCT_ROWS[0], row: 998, code: 20999, group: 'SILO PLAS/RESERV SBG', measure: '10PESX100M', thickness: '235MIC', brand: 'PACIFIL', netKg: 214, grossKg: 221, ean: null }
    const pl = buildImportPlan(input({ products: [...FIXTURE_PRODUCT_ROWS, official] }))
    expect(pl.products.find((x) => x.code === 'SB-PAC-10X100-235')).toBeUndefined()
    expect(pl.discarded.find((x) => x.code === 'SB-PAC-10X100-235')).toMatchObject({ keptCode: '20999' })
  })
  it('na reimportação o produto criado vira atualização pelo SKU', () => {
    const created = buildImportPlan(input())
    const asCurrent: CurrentVariant[] = created.products
      .filter((x) => x.code.startsWith('SB-PAC-10X'))
      .map((x, i) => ({ variantId: 9000 + i, productId: 9000 + i, sku: x.code, name: x.name, familyCode: 'SILO_BAG', familyName: 'Silo-bolsa', line: 'Silo-bolsa', brand: 'Pacifil', active: true, thicknessUm: x.thicknessUm, diameterFt: x.diameterFt, widthM: null, lengthM: x.lengthM, lengthFt: null, attrs: x.attrs, ean: null, pack: null }))
    const pl = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...FIXTURE_CURRENT.variants, ...asCurrent] } }))
    for (const c of ['SB-PAC-10X100-235', 'SB-PAC-10X60-235']) expect(P(c, pl)).toMatchObject({ action: 'UPDATE', match: { lineRelation: 'EXACT_CODE' } })
    expect(pl.deactivations.variants.some((v) => v.sku === 'SB-PAC-10X100-235' || v.sku === 'SB-PAC-10X60-235')).toBe(false)
  })
})

describe('silo-bolsa: peso líquido pelo perímetro real (14/10/2026)', () => {
  const realPerimeters = [
    { familyCode: 'SILO_BAG', diameterFt: 6, perimeterM: 5.75 },
    { familyCode: 'SILO_BAG', diameterFt: 9, perimeterM: 8.7 },
    { familyCode: 'SILO_BAG', diameterFt: 10, perimeterM: 9.65 },
  ]
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const withP = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, realPerimeters } }))
  const pkP = (code: string, pl: ImportPlan = withP) => {
    const p = P(code, pl).packaging
    if (!p) throw new Error(`${code} sem embalagem`)
    return p
  }
  // catálogo "depois de aplicar" um plano: os planejados viram variantes atuais com a embalagem planejada
  const asCurrent = (pl: ImportPlan): CurrentVariant[] =>
    pl.products.map((x, i) => ({
      variantId: 7000 + i,
      productId: 1,
      sku: x.code,
      name: x.name,
      familyCode: DEFAULT_DECISIONS.families[x.family].code,
      familyName: DEFAULT_DECISIONS.families[x.family].name,
      line: x.productLine,
      brand: x.brand,
      active: true,
      thicknessUm: x.thicknessUm,
      diameterFt: x.diameterFt,
      widthM: x.widthM,
      lengthM: x.lengthM,
      lengthFt: x.lengthFt,
      attrs: x.attrs,
      ean: x.ean,
      pack: x.packaging
        ? { packagingVersionId: 9500 + i, version: 1, locked: false, lengthMm: x.packaging.lengthMm, widthMm: x.packaging.widthMm, heightMm: x.packaging.heightMm, netKg: x.packaging.netKg, grossKg: x.packaging.grossKg, unitsPerPackage: 1, unitsPerPallet: x.packaging.unitsPerPallet, palletTypeCode: x.packaging.palletTypeCode, verification: x.packaging.verification }
        : null,
    }))
  const old = FIXTURE_CURRENT.variants.map((v) => ({ ...v, active: v.sku === 'KIT-HF' }))
  /** "Salvar perímetros e recalcular" na tela Catálogo (mesma fórmula): líquido calculado, bruto = calculado + tara; verificação copiada */
  const recalculated = (vs: CurrentVariant[]): CurrentVariant[] => {
    const table = realPerimeters.map(({ diameterFt, perimeterM }) => ({ diameterFt, perimeterM }))
    return vs.map((v) => {
      const perimeterM = v.familyCode === 'SILO_BAG' ? perimeterFor(table, v.diameterFt) : null
      const net = perimeterM != null ? siloBagNetKg({ perimeterM, lengthM: calcLengthM(v), thicknessUm: v.thicknessUm }) : null
      return v.pack && net != null ? { ...v, pack: { ...v.pack, netKg: net, grossKg: r3(net + (v.pack.grossKg - v.pack.netKg)) } } : v
    })
  }
  /** a reimportação não muda a embalagem gravada (os campos que apply.ts › samePack compara) */
  const expectSamePack = (pl: ImportPlan, cur: CurrentVariant[]) => {
    const byCode = new Map(cur.map((v) => [v.sku, v]))
    let checked = 0
    for (const x of pl.products) {
      const c = byCode.get(x.code)!
      expect(x.match).toMatchObject({ lineRelation: 'EXACT_CODE', sku: x.code, confidence: 'HIGH' })
      expect(x.existingVariantId).toBe(c.variantId)
      if (!c.pack) continue
      const pk = x.packaging!
      expect([x.code, r3(pk.netKg), r3(pk.grossKg)]).toEqual([x.code, r3(c.pack.netKg), r3(c.pack.grossKg)])
      expect([pk.lengthMm, pk.widthMm, pk.heightMm, pk.unitsPerPallet, pk.palletTypeCode, pk.verification]).toEqual([c.pack.lengthMm, c.pack.widthMm, c.pack.heightMm, c.pack.unitsPerPallet, c.pack.palletTypeCode, c.pack.verification])
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  }

  it('caixa, confiança, palete e equivalente iguais aos do plano sem a tabela; só o peso gravado muda, com a mesma tara', () => {
    expect(withP.products.map((x) => x.code)).toEqual(plan.products.map((x) => x.code))
    expect(withP.pending).toEqual(plan.pending)
    expect(withP.discarded).toEqual(plan.discarded)
    expect(withP.summary).toEqual(plan.summary)
    let calculated = 0
    for (const x of withP.products) {
      const before = P(x.code)
      expect([x.match?.sku, x.match?.confidence, x.match?.lineRelation]).toEqual([before.match?.sku, before.match?.confidence, before.match?.lineRelation])
      const a = before.packaging
      const b = x.packaging
      expect(b == null).toBe(a == null)
      if (!a || !b) continue
      const core = (k: typeof a) => [k.boxCode, k.boxSheetRow, k.lengthMm, k.widthMm, k.heightMm, k.confidence, k.palletTypeCode, k.unitsPerPallet, k.palletSource, k.grossSource, k.verification]
      expect(core(b)).toEqual(core(a))
      if (b.netSource === 'REAL_PERIMETER') {
        calculated++
        expect(x.family).toBe('SILO_BAG')
        expect(b.netKg).toBe(x.calcNetKg)
        expect(b.sheetNetKg).toBe(a.netKg)
        expect(r3(b.grossKg - b.netKg)).toBe(r3(a.grossKg - a.netKg))
        expect(b.notes.join(' ')).toContain('líquido pelo perímetro real')
      } else expect([b.netSource, b.netKg, b.grossKg]).toEqual(['SHEET', a.netKg, a.grossKg])
    }
    expect(calculated).toBeGreaterThan(10)
  })
  it('9 pés × 75 m × 208 µm (19924): 8,70 × 75 × 208 µm × 0,932 = 126,49 kg; bruto = líquido + tara da caixa', () => {
    expect(P('19924', withP).calcNetKg).toBe(126.49)
    expect(pkP('19924')).toMatchObject({ boxCode: '69490', netKg: 126.49, grossKg: 133, netSource: 'REAL_PERIMETER', sheetNetKg: 126.49, realPerimeterM: 8.7, grossSource: 'NET_PLUS_BOX_TARE' })
    expect(pkP('19924').grossNote).toContain('132,75')
    expect(P('19924', withP).dataIssues.join(' ')).toContain('líquido pelo perímetro real 8,70 m × 75 m × 208 µm × 0,932 g/cm³ = 126,49 kg (planilha 126,49 kg)')
  })
  it('pendente sem caixa também traz o calculado', () => {
    // 6 pés × 100 m × 160 µm: 5,75 × 100 × 160 µm × 0,932 = 85,74 kg
    expect(P('17303', withP)).toMatchObject({ packaging: null, calcNetKg: 85.74 })
    expect(withP.pending.find((x) => x.code === '17303')?.reasonCode).toBe('SILO_BAG_WEIGHT_GAP')
  })
  it('fora da planilha (10 pés × 100 / × 60 m × 235 µm): calculado 211,35 / 126,81 kg, observação sem "ESTIMADO"', () => {
    expect(pkP('SB-PAC-10X100-235')).toMatchObject({ netKg: 211.35, netSource: 'REAL_PERIMETER', sheetNetKg: 213.2, boxCode: '74043', grossSource: 'NET_PLUS_BOX_TARE' })
    expect(pkP('SB-PAC-10X60-235').netKg).toBe(126.81)
    for (const c of ['SB-PAC-10X100-235', 'SB-PAC-10X60-235']) {
      expect(r3(pkP(c).grossKg - pkP(c).netKg)).toBe(r3(pk(c).grossKg - pk(c).netKg))
      const obs = `${P(c, withP).notes} ${P(c, withP).dataIssues.join(' ')}`
      expect(obs).not.toContain('ESTIMADO')
      expect(obs).toContain('calculado pelo perímetro real 9,65 m ×')
    }
    expect(P('SB-PAC-10X100-235', withP).notes).toContain('= 211,35 kg (no lugar da estimativa de 213,2 kg)')
    expect(withP.warnings.find((w) => w.code === 'EXTRA_PRODUCTS')?.message).toContain('peso líquido pelo perímetro real')
  })
  it('diâmetro sem perímetro real (12 e 14 pés): peso da planilha', () => {
    expect(P('19983', withP).calcNetKg).toBeNull()
    expect(pkP('19983')).toMatchObject({ netKg: 420, grossKg: 437.45, netSource: 'SHEET' })
    expect(pkP('19983').sheetNetKg).toBeUndefined()
    expect(P('17353', withP).calcNetKg).toBeNull()
    expect(pkP('17353')).toMatchObject({ netKg: pk('17353').netKg, grossKg: pk('17353').grossKg, netSource: 'SHEET' })
  })
  it('perímetro de outra família não vale para o silo-bolsa', () => {
    const pl = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, realPerimeters: realPerimeters.map((r) => ({ ...r, familyCode: 'SILAGE_TARP' })) } }))
    expect(pl.products.every((x) => x.calcNetKg == null && x.packaging?.netSource !== 'REAL_PERIMETER')).toBe(true)
    expect(pl.warnings.find((w) => w.code === 'NET_FROM_REAL_PERIMETER')).toBeUndefined()
  })
  it('aviso: quantos silo-bolsas gravam o calculado e quais diferem mais de 2% da planilha', () => {
    const w = withP.warnings.find((x) => x.code === 'NET_FROM_REAL_PERIMETER')
    const n = withP.products.filter((x) => x.packaging?.netSource === 'REAL_PERIMETER').length
    expect(w).toMatchObject({ level: 'INFO' })
    expect(w?.message.startsWith(`${n} silo-bolsa(s) gravam`)).toBe(true)
    const far = withP.products.filter((x) => x.calcNetKg != null && x.source.netKg && Math.abs(x.calcNetKg - x.source.netKg) / x.source.netKg > 0.02).map((x) => x.code)
    expect(w?.codes ?? []).toEqual(far)
    expect(plan.warnings.find((x) => x.code === 'NET_FROM_REAL_PERIMETER')).toBeUndefined()
  })
  it('reimportação depois do recálculo: nenhuma mudança de peso nem de embalagem; tudo pelo mesmo código', () => {
    const cur = asCurrent(withP)
    const again = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...cur], realPerimeters } }))
    expect(again.summary.toUpdate).toBe(withP.summary.planned)
    expectSamePack(again, cur)
  })
  it('catálogo importado antes e recalculado na tela Catálogo (mesma fórmula): a reimportação não muda o peso', () => {
    const before = asCurrent(plan)
    const cur = recalculated(before)
    expect(cur.filter((v, i) => v.pack && v.pack.netKg !== before[i].pack?.netKg).length).toBeGreaterThan(5)
    const again = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...cur], realPerimeters } }))
    expectSamePack(again, cur)
  })
  it('verificação: embalagem VERIFICADA continua verificada importando antes ou depois do recálculo (mesmo resultado)', () => {
    // catálogo com o peso da planilha (antes de cadastrar os perímetros) e as embalagens de silo-bolsa verificadas
    const base = asCurrent(plan).map((v) => (v.pack && v.familyCode === 'SILO_BAG' ? { ...v, pack: { ...v.pack, verification: 'VERIFIED' as const } } : v))
    // ordem A: importa com a tabela já cadastrada, antes de recalcular (o líquido muda só pela fórmula)
    const a = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...base], realPerimeters } }))
    // ordem B: recalcula na tela Catálogo (copia a verificação) e depois importa
    const recalc = recalculated(base)
    const b = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...recalc], realPerimeters } }))
    expectSamePack(b, recalc)
    const state = (pl: ImportPlan) => pl.products.map((x) => [x.code, x.packaging?.netKg, x.packaging?.grossKg, x.packaging?.verification])
    expect(state(a)).toEqual(state(b))
    const calc = a.products.filter((x) => x.packaging?.netSource === 'REAL_PERIMETER')
    expect(calc.length).toBeGreaterThan(10)
    for (const x of calc) expect([x.code, x.packaging!.verification]).toEqual([x.code, 'VERIFIED'])
    // inclusive quando o calculado difere mais de 2% do peso gravado (6 pés × 60 m × 170 µm: 53 → 54,66 kg)
    const x = P('17018', a)
    const was = base.find((v) => v.sku === '17018')!.pack!
    expect(Math.abs(x.packaging!.netKg - was.netKg) / was.netKg).toBeGreaterThan(0.02)
    expect(x.packaging).toMatchObject({ verification: 'VERIFIED', netSource: 'REAL_PERIMETER' })
    // caixa diferente: deixa de ser verificada
    const otherBox = base.map((v) => (v.sku === '17018' && v.pack ? { ...v, pack: { ...v.pack, heightMm: v.pack.heightMm + 50 } } : v))
    const c = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...otherBox], realPerimeters } }))
    expect(P('17018', c).packaging?.verification).toBe('ESTIMATED')
  })
  it('ficha do produto: attrs.perimetro_m = perímetro real da família (criar e atualizar), como no recálculo', () => {
    const calc = withP.products.filter((x) => x.packaging?.netSource === 'REAL_PERIMETER')
    expect(calc.length).toBeGreaterThan(10)
    for (const x of calc) expect([x.code, x.attrs.perimetro_m]).toEqual([x.code, x.packaging!.realPerimeterM])
    // produto novo: π × D sem a tabela, o real com ela
    expect(P('19763')).toMatchObject({ action: 'CREATE', attrs: { perimetro_m: 8.618 } })
    expect(P('19763', withP)).toMatchObject({ action: 'CREATE', attrs: { perimetro_m: 8.7 } })
    // pendente sem caixa (o peso não muda) também mostra o perímetro real
    expect(P('17303', withP)).toMatchObject({ packaging: null, attrs: { perimetro_m: 5.75 } })
    // reimportação de um catálogo gravado com π × D: passa ao real (antes o valor atual prevalecia)
    const again = buildImportPlan(input({ current: { ...FIXTURE_CURRENT, variants: [...old, ...asCurrent(plan)], realPerimeters } }))
    expect(P('19763', again)).toMatchObject({ action: 'UPDATE', attrs: { perimetro_m: 8.7 } })
    // diâmetro sem perímetro real (12 pés): continua o atual / π × D
    expect(P('19983', withP).attrs.perimetro_m).toBe(P('19983').attrs.perimetro_m)
  })
})

describe('siglas de espessura da fábrica no silo-bolsa (BPT / BBT = tradicional, BPM = média; Matías, 14/10/2026)', () => {
  // as 3 versões de 9 pés × 60 m × 240 µm da planilha + o 9 × 60 × 210 com e sem BPM + um BPM "média" sem gêmeo
  const rows = [
    { row: 901, code: 19609, group: 'SILO PLAS/RESERV SBG', measure: '9PESX60M', thickness: '240MIC', brand: 'PACIFIL', netKg: 116.8, grossKg: 122.7, ean: null },
    { row: 902, code: 16859, group: 'SILO PLASTICO/RESERV', measure: 'BBT 9PESX60M', thickness: '240 MICRAS', brand: 'PACIFIL', netKg: 114.2, grossKg: 120.1, ean: null },
    { row: 903, code: 16690, group: 'SILO PLASTICO/RESERV', measure: 'BPT 9PESX60M', thickness: '240 MICRAS', brand: 'PACIFIL', netKg: 114.5, grossKg: 120.41, ean: null },
    { row: 904, code: 18174, group: 'SILO PLASTICO/RESERV', measure: 'BPM 9PESX60M', thickness: '210 MICRAS', brand: 'PACIFIL', netKg: 102.17, grossKg: 108.08, ean: null },
    { row: 905, code: 18143, group: 'SILO PLAS/RESERV SBG', measure: '9PESX60M', thickness: '210MIC', brand: 'PACIFIL', netKg: 102.17, grossKg: 108.08, ean: null },
    { row: 906, code: 19052, group: 'SILO PLASTICO/RESERV', measure: 'BPM 9PESX150M', thickness: '220 MICRAS / MEDIA', brand: 'PACIFIL', netKg: 261.5, grossKg: 270, ean: null },
  ]
  const pl = buildImportPlan(input({ products: [...FIXTURE_PRODUCT_ROWS.filter((r) => !rows.some((x) => x.code === r.code)), ...rows] }))
  const Q = (c: string) => pl.products.find((x) => x.code === c)
  it('a sigla sai do nome e a mesma medida e espessura com e sem sigla é repetida: fica o código mais recente', () => {
    expect(Q('19609')?.name).toBe('Silo-bolsa 9 pés × 60 m × 240 µm')
    for (const c of ['16859', '16690']) expect(pl.discarded.find((x) => x.code === c)).toMatchObject({ keptCode: '19609' })
    expect(pl.discarded.find((x) => x.code === '16690')?.reason).toContain('sigla de espessura')
    // o mais recente pode ser o que tinha a sigla: fica, com o nome sem ela
    expect(Q('18174')?.name).toBe('Silo-bolsa 9 pés × 60 m × 210 µm')
    expect(pl.discarded.find((x) => x.code === '18143')).toMatchObject({ keptCode: '18174' })
    expect(Q('18174')?.dataIssues.join(' ')).toContain('sigla de espessura da fábrica (BPM)')
  })
  it('"MEDIA" na espessura também sai do nome; sem gêmeo, o produto continua', () => {
    expect(Q('19052')?.name).toBe('Silo-bolsa 9 pés × 150 m × 220 µm')
  })
  it('nenhum par de produtos com o mesmo nome', () => {
    const names = pl.products.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
