import { describe, expect, it } from 'vitest'
import { cfopAreaWarning, cfopError, normalizeCfop } from './cfop'

describe('CFOP do pedido', () => {
  it('normaliza para N.NNN', () => {
    expect([normalizeCfop('7101'), normalizeCfop('7.101'), normalizeCfop(' 7.101 '), normalizeCfop('7,101'), normalizeCfop('5 102')]).toEqual(['7.101', '7.101', '7.101', '7.101', '5.102'])
  })
  it('vazio → null (o CFOP é opcional)', () => {
    expect([normalizeCfop(''), normalizeCfop('   '), normalizeCfop(null), normalizeCfop(undefined)]).toEqual([null, null, null, null])
    expect(cfopError(null)).toBeNull()
  })
  it('formato inválido: volta aparado e cfopError acusa (bloqueia)', () => {
    for (const raw of ['710', '71011', 'abc', '8.101', '0101', '7.1O1']) {
      const c = normalizeCfop(raw)
      expect(cfopError(c)).toBe('CFOP inválido: use 4 dígitos, ex.: 7.101')
    }
    expect(normalizeCfop(' 71011 ')).toBe('71011')
    expect(cfopError('7.101')).toBeNull()
    expect(cfopError('5.501')).toBeNull()
  })
  it('área: só aviso (nunca erro)', () => {
    expect(cfopAreaWarning('7.101', 'EXPORT')).toBeNull()
    expect(cfopAreaWarning('5.501', 'EXPORT')).toMatch(/não é de exportação/)
    expect(cfopAreaWarning('5.102', 'DOMESTIC')).toBeNull()
    expect(cfopAreaWarning('6.102', 'DOMESTIC')).toBeNull()
    expect(cfopAreaWarning('7.101', 'DOMESTIC')).toMatch(/é de exportação/)
    expect(cfopAreaWarning('1.102', 'DOMESTIC')).toMatch(/de entrada/)
    // vazio ou inválido: sem aviso (o erro, se houver, é de cfopError)
    expect(cfopAreaWarning(null, 'EXPORT')).toBeNull()
    expect(cfopAreaWarning('abc', 'DOMESTIC')).toBeNull()
  })
})
