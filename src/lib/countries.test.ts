import { describe, expect, it } from 'vitest'
import { canonicalCountry, countryCode, countryInText, countryNamePt } from './countries'

describe('países: grafias do ERP da fábrica', () => {
  it('as 6 grafias que o Intl não reconhece', () => {
    expect(countryCode('HOLANDA')).toBe('NL')
    expect(countryCode('FEDERACAO RUSSA')).toBe('RU')
    expect(countryCode('Federação Russa')).toBe('RU')
    expect(countryCode('Russia')).toBe('RU')
    expect(countryCode('REPUB.DOMINICANA')).toBe('DO')
    expect(countryCode('EMIR.ARABES UNIDO')).toBe('AE')
    expect(countryCode('Emirados Árabes Unidos')).toBe('AE')
    expect(countryCode('HONG KONG')).toBe('HK')
    expect(countryCode('FORMOSA(TAIWAN)')).toBe('TW')
    expect(countryCode('Formosa')).toBe('TW')
  })
  it('gravadas com o nome oficial em português', () => {
    expect(canonicalCountry('HOLANDA')).toBe(countryNamePt('NL'))
    expect(canonicalCountry('REPUB.DOMINICANA')).toBe('República Dominicana')
    expect(canonicalCountry('FORMOSA(TAIWAN)')).toBe(countryNamePt('TW'))
    // o nome oficial volta ao mesmo código (editar o cliente não perde o país)
    for (const erp of ['HOLANDA', 'FEDERACAO RUSSA', 'REPUB.DOMINICANA', 'EMIR.ARABES UNIDO', 'HONG KONG', 'FORMOSA(TAIWAN)']) {
      const c = canonicalCountry(erp)
      expect(c).not.toBeNull()
      expect(countryCode(c)).toBe(countryCode(erp))
    }
  })
  it('grafias que já funcionavam continuam iguais', () => {
    expect(countryCode('Uruguai')).toBe('UY')
    expect(countryCode('ESTADOS UNIDOS')).toBe('US')
    expect(countryCode('Guiné-Bissau')).toBe('GW')
    expect(countryCode('guine bissau')).toBe('GW')
    expect(countryCode('uy')).toBe('UY')
    expect(countryCode('BELARUS')).toBe('BY')
    expect(countryCode('Atlântida')).toBeNull()
  })
  it('texto livre: "Formosa" (província argentina) não vira Taiwan', () => {
    expect(countryInText('camión completo para Formosa, Argentina')).toBe('Argentina')
    expect(countryInText('contenedor para Holanda')).toBe('Holanda')
    expect(countryInText('40HC para Uruguay.')).toBe('Uruguay')
  })
})
