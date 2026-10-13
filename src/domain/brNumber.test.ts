import { describe, expect, it } from 'vitest'
import { parseBrNumber, parseMm } from './brNumber'

describe('números no formato brasileiro', () => {
  it('ponto = milhar, vírgula = decimal; "1.8" não existe', () => {
    expect(parseBrNumber('1.800')).toBe(1800)
    expect(parseBrNumber('1800')).toBe(1800)
    expect(parseBrNumber('1,8')).toBe(1.8)
    expect(parseBrNumber('12.345,67')).toBe(12345.67)
    expect(parseBrNumber('1.8')).toBeNaN()
    expect(parseBrNumber('2,350.00')).toBeNaN()
    expect(parseBrNumber('')).toBeNull()
  })
  it('medidas em mm literais, com a unidade escrita quando houver', () => {
    expect(parseMm('1.800')).toBe(1800)
    expect(parseMm('1,8 m')).toBe(1800)
    expect(parseMm('180 cm')).toBe(1800)
    expect(parseMm('1.800 mm')).toBe(1800)
    expect(parseMm('1,8')).toBe(1.8) // literal: 1,8 mm (o sistema avisa que está fora da faixa)
    expect(parseMm('1.8 m')).toBeNaN()
  })
})
