import { describe, expect, it } from 'vitest'
import { canAccessArea, userAreas } from './areas'

describe('áreas de negócio (Exportação × Mercado Interno)', () => {
  it('cada usuário vê só as suas áreas; o ADMIN vê todas', () => {
    expect(userAreas({ role: 'EXPORT_ASSISTANT', areas: ['EXPORT'] })).toEqual(['EXPORT'])
    expect(canAccessArea({ role: 'EXPORT_ASSISTANT', areas: ['DOMESTIC'] }, 'EXPORT')).toBe(false)
    expect(canAccessArea({ role: 'EXPORT_MANAGER', areas: ['EXPORT', 'DOMESTIC'] }, 'DOMESTIC')).toBe(true)
    expect(userAreas({ role: 'ADMIN', areas: [] })).toEqual(['EXPORT', 'DOMESTIC'])
  })
})
