import { describe, expect, it } from 'vitest'
import { backupFileName, base64Bytes, CONFIRM_WORD, type LoadCounts, photoMeta, sameCounts, stripBinaryBlocks, truncateLongStrings, validateDeleteInput } from './backupFormat'

const SHA = 'a'.repeat(64)

describe('stripBinaryBlocks', () => {
  it('troca o base64 das imagens/PDFs por { omitted, bytes } em qualquer nível e mantém o resto', () => {
    const data = Buffer.from('0123456789').toString('base64') // 10 bytes
    const content = [
      { type: 'text', text: 'pedido em anexo' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] },
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
    ]
    const out = stripBinaryBlocks(content) as typeof content
    expect(out[0]).toEqual(content[0])
    expect(out[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: { omitted: true, bytes: 10 } } })
    expect(JSON.stringify(out)).not.toContain(data)
    expect(out[3]).toEqual(content[3])
    // o original não é alterado
    expect(content[1]).toMatchObject({ source: { data } })
  })

  it('base64Bytes desconta o preenchimento', () => {
    expect(base64Bytes(Buffer.from('ab').toString('base64'))).toBe(2)
    expect(base64Bytes(Buffer.from('abc').toString('base64'))).toBe(3)
    expect(base64Bytes('')).toBe(0)
  })
})

describe('photoMeta', () => {
  it('só os dados, nunca os bytes', () => {
    const row = { id: 1, loadPlanId: 2, loadPlanVersionId: 3, mime: 'image/jpeg', data: Buffer.alloc(10), thumb: Buffer.alloc(5), medium: Buffer.alloc(7), width: 1600, height: 1200, sizeBytes: 10, caption: 'frente', takenAt: null, createdAt: '2026-10-13T10:00:00Z', createdBy: 1 }
    const m = photoMeta(row)
    expect(m).not.toHaveProperty('data')
    expect(m).not.toHaveProperty('thumb')
    expect(m).not.toHaveProperty('medium')
    expect(m).toMatchObject({ id: 1, loadPlanId: 2, mime: 'image/jpeg', sizeBytes: 10, caption: 'frente' })
  })
})

describe('truncateLongStrings', () => {
  it('corta só os textos longos, em qualquer nível', () => {
    const v = { a: 'x'.repeat(30), b: { c: ['curto', 'y'.repeat(30)] }, n: 5 }
    const t = truncateLongStrings(v, 10) as { a: string; b: { c: string[] }; n: number }
    expect(t.a).toMatch(/^x{10}… \[cortado no backup: 30 caracteres\]$/)
    expect(t.b.c[0]).toBe('curto')
    expect(t.b.c[1].startsWith('y'.repeat(10))).toBe(true)
    expect(t.n).toBe(5)
  })
  it('datas viram texto ISO (não {}), também dentro de objetos e listas', () => {
    const at = new Date('2026-10-13T12:34:56.789Z')
    const row = { id: 1, at, input: { when: at, list: [at] }, error: null }
    const t = truncateLongStrings(row) as Record<string, unknown>
    expect(t.at).toBe('2026-10-13T12:34:56.789Z')
    expect(JSON.parse(JSON.stringify(t))).toEqual({ id: 1, at: '2026-10-13T12:34:56.789Z', input: { when: '2026-10-13T12:34:56.789Z', list: ['2026-10-13T12:34:56.789Z'] }, error: null })
  })
})

describe('backupFileName', () => {
  it('hora de Brasília', () => {
    expect(backupFileName(new Date('2026-10-13T23:30:00Z'))).toBe('backup-cargas-2026-10-13T20-30.json.gz')
    expect(backupFileName(new Date('2026-10-14T02:05:00Z'))).toBe('backup-cargas-2026-10-13T23-05.json.gz')
  })
})

describe('validateDeleteInput', () => {
  it('exige EXCLUIR exatamente, backup guardado e sha256', () => {
    expect(validateDeleteInput({ confirm: CONFIRM_WORD, backupSha256: SHA, savedBackup: true })).toBeNull()
    expect(validateDeleteInput({ confirm: ' EXCLUIR ', backupSha256: SHA, savedBackup: true })).toBeNull()
    expect(validateDeleteInput({ confirm: 'excluir', backupSha256: SHA, savedBackup: true })).toMatch(/Digite EXCLUIR/)
    expect(validateDeleteInput({ confirm: 'EXCLUIR', backupSha256: SHA, savedBackup: false })).toMatch(/Baixei e guardei/)
    expect(validateDeleteInput({ confirm: 'EXCLUIR', backupSha256: 'abc', savedBackup: true })).toMatch(/Baixe o backup/)
    expect(validateDeleteInput(null)).toBe('Pedido inválido.')
  })
})

describe('sameCounts', () => {
  const c: LoadCounts = { shipments: 1, loadPlans: 2, loadPlanVersions: 3, approvedVersions: 1, draftVersions: 2, photos: 0, priceQuotes: 4, exportOperations: 1, exportEvents: 5, aiConversations: 6, aiMessages: 7, aiToolCalls: 8 }
  it('compara todas as quantidades', () => {
    expect(sameCounts({ ...c }, c)).toBe(true)
    expect(sameCounts({ ...c, aiMessages: 8 }, c)).toBe(false)
    expect(sameCounts({ shipments: 1 }, c)).toBe(false)
    expect(sameCounts(null, c)).toBe(false)
  })
})
