/**
 * DESFAZER APROVAÇÃO (núcleo puro, sem banco): decide se uma versão aprovada pode voltar para rascunho
 * e qual versão substituída volta a ser a aprovada da carga. Usado pela Server Action (dentro da
 * transação, com as versões travadas) e pela página da carga (para mostrar ou não o botão).
 *
 * Regras:
 *   - só a versão APROVADA que é a ÚLTIMA da carga (sem versão mais nova, de nenhum status);
 *   - nunca com seguimento de exportação (pedido confirmado): primeiro desfaz-se a confirmação;
 *   - a aprovação desta versão tinha substituído a anterior → volta a aprovada a SUBSTITUÍDA aprovada
 *     por último (maior approvedAt: a aprovação guarda a data ao substituir). NÃO é a de maior número:
 *     dá para aprovar uma versão mais antiga depois de uma mais nova (ex.: V2 aprovada, depois V1, depois
 *     V3 → desfazer V3 devolve a V1). Sem data (linhas antigas) conta como a mais antiga; empate → maior
 *     número. Se, por algum motivo, já existir outra versão aprovada, nada é restaurado (nunca duas
 *     aprovadas na mesma carga).
 */

export type PlanStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED'

export interface VersionRef {
  id: number
  version: number
  status: PlanStatus
  /** data da aprovação (mantida quando a versão é substituída; limpa ao desfazer) */
  approvedAt?: Date | null
}

/** por que não dá para desfazer (vira o código ?erro= da página da carga) */
export type UndoApprovalBlock = 'not_found' | 'not_approved' | 'not_latest' | 'export_operation'

export type UndoApprovalPlan<V extends VersionRef = VersionRef> = { ok: true; restore: V | null } | { ok: false; reason: UndoApprovalBlock }

/** b foi aprovada depois de a? (sem data = mais antiga; empate → maior número) */
function approvedLater(a: VersionRef, b: VersionRef) {
  const ta = a.approvedAt?.getTime() ?? -Infinity
  const tb = b.approvedAt?.getTime() ?? -Infinity
  return tb !== ta ? tb > ta : b.version > a.version
}

export function planUndoApproval<V extends VersionRef>(versions: readonly V[], versionId: number, o: { exportOperation: boolean }): UndoApprovalPlan<V> {
  const v = versions.find((x) => x.id === versionId)
  if (!v) return { ok: false, reason: 'not_found' }
  if (v.status !== 'APPROVED') return { ok: false, reason: 'not_approved' }
  if (versions.some((x) => x.id !== v.id && x.version > v.version)) return { ok: false, reason: 'not_latest' }
  if (o.exportOperation) return { ok: false, reason: 'export_operation' }
  if (versions.some((x) => x.id !== v.id && x.status === 'APPROVED')) return { ok: true, restore: null }
  const restore = versions.filter((x) => x.id !== v.id && x.status === 'SUPERSEDED').reduce<V | null>((a, b) => (!a || approvedLater(a, b) ? b : a), null)
  return { ok: true, restore }
}
