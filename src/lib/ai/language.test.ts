import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/db', () => ({ db: {}, schema: {} }))
import { replyLanguage } from './service'

describe('idioma da resposta', () => {
  it('detecta espanhol e português', () => {
    expect(replyLanguage('Montá un 40 HC con 60% Hidrosilo 5.000 L y 40% Hidrosilo 20.000 L')).toBe('espanhol')
    expect(replyLanguage('Sacá el último pallet')).toBe('espanhol')
    expect(replyLanguage('Monte um 40 HC com 100% Hidrosilo 10.000 L')).toBe('português')
    expect(replyLanguage('Coloque 2 paletes de 20.000 e complete com 5.000')).toBe('português')
  })
})
