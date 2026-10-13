import { describe, expect, it } from 'vitest'
import { familyTech, isTechKey, parseTechOption, TECH_OPTIONS, techBadge, techOptionValue, TECHNOLOGIES } from './technology'

describe('tecnologia comercial da família (PACIFIL NXT)', () => {
  it('lê as colunas do Catálogo: NXT com menção ou selo', () => {
    expect(familyTech({ technology: 'NXT', technologyDisplay: 'SEAL' })).toEqual({ key: 'NXT', display: 'SEAL' })
    expect(familyTech({ technology: 'NXT', technologyDisplay: 'MENTION' })).toEqual({ key: 'NXT', display: 'MENTION' })
  })

  it('valor desconhecido ou incompleto = sem tecnologia (nunca inventa selo)', () => {
    expect(familyTech({ technology: null, technologyDisplay: null })).toBeNull()
    expect(familyTech({ technology: 'NXT', technologyDisplay: null })).toBeNull()
    expect(familyTech({ technology: 'NXT_EVOH', technologyDisplay: 'SEAL' })).toBeNull()
    expect(familyTech({ technology: 'NXT', technologyDisplay: 'BIG' })).toBeNull()
    expect(familyTech({})).toBeNull()
    expect(isTechKey('toString')).toBe(false)
  })

  it('opções do seletor no Catálogo: nenhuma, NXT menção e NXT selo (NXT+EVOH ainda não)', () => {
    expect(TECH_OPTIONS.map((o) => o.value)).toEqual(['', 'NXT:MENTION', 'NXT:SEAL'])
    expect(parseTechOption('')).toBeNull()
    expect(parseTechOption('NXT:SEAL')).toEqual({ key: 'NXT', display: 'SEAL' })
    expect(parseTechOption('NXT:XYZ')).toBeUndefined()
    expect(parseTechOption('EVOH:SEAL')).toBeUndefined()
    for (const o of TECH_OPTIONS) expect(techOptionValue(parseTechOption(o.value) ?? null)).toBe(o.value)
  })

  it('selo, título e texto da NXT nos três idiomas', () => {
    expect(TECHNOLOGIES.NXT.seal).toBe('/brand/pacifil-nxt-selo.png')
    expect(TECHNOLOGIES.NXT.title).toBe('PACIFIL NXT — Next Generation Technology')
    for (const lang of ['es', 'pt', 'en'] as const) expect(TECHNOLOGIES.NXT.text[lang]).toMatch(/nano/i)
    expect(techBadge({ key: 'NXT', display: 'SEAL' })).toBe('PACIFIL NXT · selo')
    expect(techBadge({ key: 'NXT', display: 'MENTION' })).toBe('PACIFIL NXT')
  })
})
