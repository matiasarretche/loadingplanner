import { describe, expect, it, vi } from 'vitest'

// só as funções puras (validação da tabela e decisão do recálculo); nada de banco
vi.mock('@/db', () => ({ db: {}, schema: {} }))

import { decideRecalc, normalizePerimeterRows, perimeterRowError, recalcNote, roundPerimeterM, SiloPerimeterError } from './siloPerimeters'

const TABLE = [
  { diameterFt: 6, perimeterM: 5.75 },
  { diameterFt: 9, perimeterM: 8.7 },
  { diameterFt: 10, perimeterM: 9.65 },
]
const sb = (diameterFt: number | null, lengthM: number | null, thicknessUm: number | null, lengthFt: number | null = null) => ({ sku: 'SB', name: 'Silo-bolsa', diameterFt, lengthM, lengthFt, thicknessUm })
const pk = (netKg: number, grossKg: number | null, unitsPerPackage = 1) => ({ version: 1, netKg, grossKg, unitsPerPackage })

describe('tabela de perímetros reais', () => {
  it('aceita os perímetros definidos e recusa erro de digitação', () => {
    expect(perimeterRowError(9, 8.7)).toBeNull()
    expect(perimeterRowError(6, 5.75)).toBeNull()
    expect(perimeterRowError(9, 87)).toMatch(/Fora do esperado.*8,62 m/)
    expect(perimeterRowError(9, 0)).toMatch(/maior que zero/)
    expect(perimeterRowError(0, 8.7)).toMatch(/Diâmetro/)
  })

  it('arredonda como o banco (2 casas no diâmetro, 3 no perímetro) e ordena pelo diâmetro', () => {
    expect(normalizePerimeterRows([{ diameterFt: 10, perimeterM: 9.6504 }, { diameterFt: 9, perimeterM: 8.7 }])).toEqual([
      { diameterFt: 9, perimeterM: 8.7 },
      { diameterFt: 10, perimeterM: 9.65 },
    ])
  })

  it('recusa diâmetro repetido (mesma chave de 2 casas)', () => {
    expect(() => normalizePerimeterRows([{ diameterFt: 9, perimeterM: 8.7 }, { diameterFt: 9.001, perimeterM: 8.71 }])).toThrow(SiloPerimeterError)
  })
})

describe('recálculo do peso pelo perímetro real', () => {
  it('diâmetro sem perímetro real: não mexe (vale a planilha da fábrica)', () => {
    expect(decideRecalc(TABLE, sb(12, 152.4, 276), pk(450, 467.45))).toEqual({ kind: 'none' })
    expect(decideRecalc(TABLE, sb(null, 60, 210), pk(100, 105))).toEqual({ kind: 'none' })
  })

  it('9 pés × 75 m × 244 µm: 8,70 × 75 × 244 × 0,932 = 148,38 kg; bruto mantém a tara (6,51 kg)', () => {
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(147, 153.51))).toEqual({ kind: 'change', perimeterM: 8.7, lengthM: 75, thicknessUm: 244, netKg: 148.38, grossKg: 154.89 })
  })

  it('já recalculado: nada a fazer (salvar de novo não cria versão)', () => {
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(148.38, 154.89))).toEqual({ kind: 'same', perimeterM: 8.7 })
  })

  it('vendido em pés: comprimento = pés × 0,3048', () => {
    const d = decideRecalc(TABLE, sb(10, null, 257, 250), pk(175, 181.96))
    expect(d).toMatchObject({ kind: 'change', lengthM: 76.2, netKg: 176.13, grossKg: 183.09 })
  })

  it('lista o que não dá para recalcular, com o motivo', () => {
    expect(decideRecalc(TABLE, sb(9, 75, 244), null)).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/Sem embalagem/) })
    expect(decideRecalc(TABLE, sb(9, 75, null), pk(147, 153.51))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/espessura/) })
    expect(decideRecalc(TABLE, sb(9, null, 244), pk(147, 153.51))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/comprimento/) })
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(147, 153.51, 2))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/2 unidades/) })
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(147, 140))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/menor que o líquido/) })
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(147, null))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/c\/ embalagem não cadastrado/) })
  })

  it('líquido 0 ("não informado"): sem tara conhecida, não recalcula (não dobra o peso c/ embalagem)', () => {
    expect(decideRecalc(TABLE, sb(9, 75, 244), pk(0, 153.51))).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/líquido não cadastrado/) })
  })

  it('arredonda o perímetro antes de validar e gravar (a tela valida e calcula com o mesmo valor)', () => {
    expect(normalizePerimeterRows([{ diameterFt: 9, perimeterM: 8.7055 }])).toEqual([{ diameterFt: 9, perimeterM: 8.706 }])
    expect(roundPerimeterM(8.7055)).toBe(8.706)
  })

  it('observação da nova versão traz a fórmula e o peso anterior', () => {
    expect(recalcNote({ perimeterM: 8.7, lengthM: 75, thicknessUm: 244, netKg: 148.38 }, 147)).toBe(
      'Peso líquido pelo perímetro real: 8,70 m × 75 m × 244 µm × 0,932 g/cm³ = 148,38 kg (antes 147,00 kg)',
    )
  })
})
