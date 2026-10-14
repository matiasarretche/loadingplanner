import { describe, expect, it } from 'vitest'
import {
  calcLengthM,
  decideRecalc,
  diameterKey,
  isCalculatedNet,
  packRecalcBlocker,
  perimeterFor,
  perimeterRowError,
  roundPerimeterM,
  siloBagFormulaText,
  siloBagNetKg,
  theoreticalPerimeterM,
} from './siloPerimeter'

const TABLE = [
  { diameterFt: 6, perimeterM: 5.75 },
  { diameterFt: 9, perimeterM: 8.7 },
  { diameterFt: 10, perimeterM: 9.65 },
]

describe('peso líquido do silo-bolsa pelo perímetro real (0,932 g/cm³)', () => {
  it('fórmula com 2 casas, como a planilha da fábrica', () => {
    // 19924: 9 pés × 75 m × 208 µm → a planilha traz exatamente 126,49 kg
    expect(siloBagNetKg({ perimeterM: 8.7, lengthM: 75, thicknessUm: 208 })).toBe(126.49)
    // 18143: 9 × 60 × 210 → 102,17 (planilha 102,17)
    expect(siloBagNetKg({ perimeterM: 8.7, lengthM: 60, thicknessUm: 210 })).toBe(102.17)
    // 19641: 6 × 60 × 180 → 57,88 (planilha 57,8)
    expect(siloBagNetKg({ perimeterM: 5.75, lengthM: 60, thicknessUm: 180 })).toBe(57.88)
    // SB-PAC-10X100-235: 9,65 × 100 × 235 → 211,35
    expect(siloBagNetKg({ perimeterM: 9.65, lengthM: 100, thicknessUm: 235 })).toBe(211.35)
  })
  it('sem algum dado não calcula (nunca grava 0)', () => {
    expect(siloBagNetKg({ perimeterM: null, lengthM: 60, thicknessUm: 210 })).toBeNull()
    expect(siloBagNetKg({ perimeterM: 8.7, lengthM: null, thicknessUm: 210 })).toBeNull()
    expect(siloBagNetKg({ perimeterM: 8.7, lengthM: 60, thicknessUm: null })).toBeNull()
    expect(siloBagNetKg({ perimeterM: 0, lengthM: 60, thicknessUm: 210 })).toBeNull()
  })
  it('perímetro por diâmetro, com tolerância de 0,01 pé; diâmetro sem cadastro → null', () => {
    expect(perimeterFor(TABLE, 9)).toBe(8.7)
    expect(perimeterFor(TABLE, 9.004)).toBe(8.7)
    expect(perimeterFor(TABLE, 12)).toBeNull()
    expect(perimeterFor(TABLE, null)).toBeNull()
  })
  it('comprimento em pés entra convertido', () => {
    expect(calcLengthM({ lengthM: 60, lengthFt: null })).toBe(60)
    expect(calcLengthM({ lengthM: null, lengthFt: 200 })).toBeCloseTo(60.96, 6)
    expect(calcLengthM({ lengthM: null, lengthFt: null })).toBeNull()
  })
  it('perímetro matemático, chave do diâmetro, texto da fórmula e "é o calculado"', () => {
    expect(theoreticalPerimeterM(9)).toBeCloseTo(8.618, 3)
    expect(diameterKey(11.5)).toBe('11.50')
    expect(siloBagFormulaText({ perimeterM: 8.7, lengthM: 60, thicknessUm: 240 })).toBe('8,70 m × 60 m × 240 µm × 0,932 g/cm³')
    expect(isCalculatedNet(102.17, 102.17)).toBe(true)
    // igual nas 3 casas do banco — a mesma definição do recálculo: 102,166 não é o calculado (seria regravado)
    expect(isCalculatedNet(102.166, 102.17)).toBe(false)
    expect(isCalculatedNet(102.2, 102.17)).toBe(false)
    expect(isCalculatedNet(null, 102.17)).toBe(false)
  })
})

describe('regras únicas para servidor e tela', () => {
  const sb = { sku: 'SB', name: 'Silo-bolsa', diameterFt: 9, lengthM: 60, lengthFt: null, thicknessUm: 240 }

  it('perímetro com as 3 casas do banco', () => {
    expect(roundPerimeterM(8.7055)).toBe(8.706)
    expect(roundPerimeterM(8.7004)).toBe(8.7)
  })

  it('validação da linha: a tela usa a mesma do servidor', () => {
    expect(perimeterRowError(9, roundPerimeterM(8.7))).toBeNull()
    expect(perimeterRowError(9, 87)).toMatch(/Fora do esperado para 9 pés/)
    expect(perimeterRowError(9, NaN)).toMatch(/maior que zero/)
  })

  it('embalagem que o recálculo não altera: um texto só ("Peso c/ embalagem"), o mesmo no selo e no recálculo', () => {
    expect(packRecalcBlocker({ unitsPerPackage: 1, netKg: 116, grossKg: 120 })).toBeNull()
    expect(packRecalcBlocker({ unitsPerPackage: 2, netKg: 116, grossKg: 120 })).toMatch(/2 unidades por caixa/)
    expect(packRecalcBlocker({ unitsPerPackage: 1, netKg: 116, grossKg: null })).toMatch(/^Peso c\/ embalagem não cadastrado/)
    expect(packRecalcBlocker({ unitsPerPackage: 1, netKg: 0, grossKg: 153.51 })).toMatch(/^Peso líquido não cadastrado/)
    expect(packRecalcBlocker({ unitsPerPackage: 1, netKg: 116, grossKg: 110 })).toMatch(/^Peso c\/ embalagem \(110,00 kg\) menor que o líquido \(116,00 kg\)/)
    const pack = { version: 1, netKg: 116, grossKg: null, unitsPerPackage: 1 }
    expect(decideRecalc([{ diameterFt: 9, perimeterM: 8.7 }], sb, pack)).toEqual({ kind: 'skip', perimeterM: 8.7, reason: packRecalcBlocker(pack) })
  })

  it('"é o calculado" = "nada a fazer" do recálculo: 116,763 com cálculo 116,76 é regravado', () => {
    const table = [{ diameterFt: 9, perimeterM: 8.7 }]
    // 8,70 × 60 × 240 × 0,932 = 116,76
    expect(decideRecalc(table, sb, { version: 1, netKg: 116.76, grossKg: 120.76, unitsPerPackage: 1 })).toEqual({ kind: 'same', perimeterM: 8.7 })
    expect(decideRecalc(table, sb, { version: 1, netKg: 116.763, grossKg: 120.763, unitsPerPackage: 1 })).toMatchObject({ kind: 'change', netKg: 116.76, grossKg: 120.76 })
  })
})
