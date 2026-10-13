import { describe, expect, it } from 'vitest'
import { planUndoApproval, VersionRef } from './approval'

/** approvedAt: dia da aprovação (aprovadas/substituídas); omitido = linha antiga sem data */
const ver = (version: number, status: VersionRef['status'], day?: number): VersionRef => ({ id: 100 + version, version, status, ...(day != null ? { approvedAt: new Date(Date.UTC(2026, 9, day)) } : {}) })
const noOp = { exportOperation: false }

describe('desfazer aprovação', () => {
  it('última versão aprovada, sem versão anterior: pode, nada a restaurar', () => {
    expect(planUndoApproval([ver(1, 'APPROVED')], 101, noOp)).toEqual({ ok: true, restore: null })
  })

  it('última versão aprovada que substituiu a anterior: restaura a substituída', () => {
    const vs = [ver(2, 'APPROVED'), ver(1, 'SUPERSEDED')]
    expect(planUndoApproval(vs, 102, noOp)).toEqual({ ok: true, restore: ver(1, 'SUPERSEDED') })
  })

  it('existe versão mais nova (de qualquer status): não pode', () => {
    expect(planUndoApproval([ver(1, 'APPROVED'), ver(2, 'DRAFT')], 101, noOp)).toEqual({ ok: false, reason: 'not_latest' })
    expect(planUndoApproval([ver(1, 'SUPERSEDED'), ver(2, 'APPROVED')], 101, noOp)).toEqual({ ok: false, reason: 'not_approved' })
    expect(planUndoApproval([ver(1, 'APPROVED'), ver(2, 'IN_REVIEW')], 101, noOp)).toEqual({ ok: false, reason: 'not_latest' })
  })

  it('versão que não está aprovada: não pode', () => {
    for (const s of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED'] as const) expect(planUndoApproval([ver(1, s)], 101, noOp)).toEqual({ ok: false, reason: 'not_approved' })
  })

  it('versão inexistente', () => {
    expect(planUndoApproval([ver(1, 'APPROVED')], 999, noOp)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('pedido confirmado (seguimento de exportação): não pode', () => {
    expect(planUndoApproval([ver(2, 'APPROVED'), ver(1, 'SUPERSEDED')], 102, { exportOperation: true })).toEqual({ ok: false, reason: 'export_operation' })
  })

  it('restaura a SUBSTITUÍDA aprovada por último (pulando rascunhos e as mais antigas)', () => {
    const vs = [ver(5, 'APPROVED', 9), ver(4, 'DRAFT'), ver(3, 'SUPERSEDED', 5), ver(2, 'IN_REVIEW'), ver(1, 'SUPERSEDED', 2)]
    const r = planUndoApproval(vs, 105, noOp)
    expect(r).toEqual({ ok: true, restore: ver(3, 'SUPERSEDED', 5) })
  })

  it('ordem de aprovação, não número: V2 aprovada, depois V1, depois V3 → desfazer V3 devolve a V1', () => {
    const vs = [ver(1, 'SUPERSEDED', 3), ver(2, 'SUPERSEDED', 1), ver(3, 'APPROVED', 6)]
    expect(planUndoApproval(vs, 103, noOp)).toEqual({ ok: true, restore: ver(1, 'SUPERSEDED', 3) })
  })

  it('duas alternativas (aprova uma, troca para a outra), depois uma nova: volta a escolhida por último', () => {
    // V2 e V3 alternativas: aprovou V3, trocou para V2; V4 (cópia da V2) aprovada e desfeita → V2
    const vs = [ver(1, 'DRAFT'), ver(2, 'SUPERSEDED', 4), ver(3, 'SUPERSEDED', 2), ver(4, 'APPROVED', 8)]
    expect(planUndoApproval(vs, 104, noOp)).toEqual({ ok: true, restore: ver(2, 'SUPERSEDED', 4) })
  })

  it('linhas antigas sem data de aprovação: a de maior número; com data ganha de sem data', () => {
    const legacy = [ver(5, 'APPROVED'), ver(4, 'DRAFT'), ver(3, 'SUPERSEDED'), ver(2, 'IN_REVIEW'), ver(1, 'SUPERSEDED')]
    expect(planUndoApproval(legacy, 105, noOp)).toEqual({ ok: true, restore: ver(3, 'SUPERSEDED') })
    const mixed = [ver(4, 'APPROVED', 9), ver(3, 'SUPERSEDED'), ver(1, 'SUPERSEDED', 2)]
    expect(planUndoApproval(mixed, 104, noOp)).toEqual({ ok: true, restore: ver(1, 'SUPERSEDED', 2) })
  })

  it('mesma data de aprovação: desempata pelo maior número', () => {
    const vs = [ver(3, 'APPROVED', 9), ver(2, 'SUPERSEDED', 4), ver(1, 'SUPERSEDED', 4)]
    expect(planUndoApproval(vs, 103, noOp)).toEqual({ ok: true, restore: ver(2, 'SUPERSEDED', 4) })
  })

  it('sem substituída abaixo (só rascunhos/revisão): nada a restaurar', () => {
    const vs = [ver(3, 'APPROVED'), ver(2, 'DRAFT'), ver(1, 'IN_REVIEW')]
    expect(planUndoApproval(vs, 103, noOp)).toEqual({ ok: true, restore: null })
  })

  it('já existe outra aprovada (dado anômalo): desfaz sem restaurar nada', () => {
    const vs = [ver(3, 'APPROVED'), ver(2, 'SUPERSEDED'), ver(1, 'APPROVED')]
    expect(planUndoApproval(vs, 103, noOp)).toEqual({ ok: true, restore: null })
  })

  it('a ordem da lista não importa', () => {
    const vs = [ver(1, 'SUPERSEDED', 1), ver(4, 'APPROVED', 9), ver(3, 'SUPERSEDED', 3), ver(2, 'SUPERSEDED', 5)]
    expect(planUndoApproval(vs, 104, noOp)).toEqual({ ok: true, restore: ver(2, 'SUPERSEDED', 5) })
    expect(planUndoApproval([...vs].reverse(), 104, noOp)).toEqual({ ok: true, restore: ver(2, 'SUPERSEDED', 5) })
  })
})
