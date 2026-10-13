/**
 * Formato do BACKUP DAS CARGAS (Manutenção › Excluir todas as cargas e proformas) e validações da exclusão.
 * Sem dependências de servidor: a tela usa as mesmas regras (palavra de confirmação) e os testes rodam puros.
 */

/** palavra que o usuário digita para confirmar a exclusão (exatamente assim, maiúsculas) */
export const CONFIRM_WORD = 'EXCLUIR'
/** o backup vale para excluir por este tempo depois de baixado */
export const BACKUP_VALID_MINUTES = 60
/** textos maiores que isso nas chamadas de ferramenta da IA são cortados no backup */
export const MAX_TOOL_STRING = 20 * 1024

export const BACKUP_KIND = 'pacifil-backup-cargas'
export const BACKUP_VERSION = 1

/** contagens das tabelas apagadas (as mesmas no backup, na auditoria e na conferência antes de excluir) */
export interface LoadCounts {
  shipments: number
  loadPlans: number
  loadPlanVersions: number
  approvedVersions: number
  draftVersions: number
  photos: number
  priceQuotes: number
  exportOperations: number
  exportEvents: number
  aiConversations: number
  aiMessages: number
  aiToolCalls: number
}

export const COUNT_KEYS: (keyof LoadCounts)[] = ['shipments', 'loadPlans', 'loadPlanVersions', 'approvedVersions', 'draftVersions', 'photos', 'priceQuotes', 'exportOperations', 'exportEvents', 'aiConversations', 'aiMessages', 'aiToolCalls']

/** mesmas contagens? (compara só as chaves conhecidas; ausente = diferente) */
export function sameCounts(a: Partial<LoadCounts> | null | undefined, b: LoadCounts): boolean {
  if (!a) return false
  return COUNT_KEYS.every((k) => Number(a[k]) === b[k])
}

/** tamanho em bytes do conteúdo de um texto base64 (sem decodificar) */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s+/g, '')
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
}

/**
 * Conteúdo das mensagens da IA sem os arquivos embutidos: cada `source: { type: 'base64', data }` (imagens e
 * PDFs anexados) vira `data: { omitted: true, bytes }`. Percorre tudo (inclusive resultados de ferramentas).
 */
export function stripBinaryBlocks(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(stripBinaryBlocks)
  if (!content || typeof content !== 'object') return content
  const o = content as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === 'source' && v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).type === 'base64' && typeof (v as Record<string, unknown>).data === 'string') {
      const src = v as Record<string, unknown>
      out[k] = { ...src, data: { omitted: true, bytes: base64Bytes(src.data as string) } }
    } else out[k] = stripBinaryBlocks(v)
  }
  return out
}

/**
 * Textos muito longos (entradas/saídas das ferramentas da IA) cortados, com o tamanho original. Datas viram
 * texto ISO (um Date não tem chaves próprias: copiado como objeto comum viraria {}); só objetos simples e
 * listas são percorridos.
 */
export function truncateLongStrings(v: unknown, max = MAX_TOOL_STRING): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… [cortado no backup: ${v.length} caracteres]` : v
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (Array.isArray(v)) return v.map((x) => truncateLongStrings(x, max))
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, truncateLongStrings(x, max)]))
  }
  return v
}

export interface PhotoRow {
  id: number
  loadPlanId: number
  loadPlanVersionId: number | null
  mime: string
  width: number | null
  height: number | null
  sizeBytes: number
  caption: string | null
  takenAt: Date | string | null
  createdAt: Date | string
  createdBy: number | null
}

/** foto do carregamento no backup: só os dados (as imagens não entram — o backup tem que caber no download) */
export function photoMeta(row: PhotoRow & Record<string, unknown>): PhotoRow {
  return {
    id: row.id,
    loadPlanId: row.loadPlanId,
    loadPlanVersionId: row.loadPlanVersionId,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    caption: row.caption,
    takenAt: row.takenAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

/** "backup-cargas-AAAA-MM-DDTHH-MM.json.gz" na hora de Brasília */
export function backupFileName(date: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  )
  return `backup-cargas-${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}.json.gz`
}

export interface DeleteInput {
  confirm: string
  backupSha256: string
  savedBackup: boolean
}

/** Confere o pedido de exclusão (antes de tocar no banco). null = ok; senão a mensagem para o usuário. */
export function validateDeleteInput(i: Partial<DeleteInput> | null | undefined): string | null {
  if (!i || typeof i !== 'object') return 'Pedido inválido.'
  if (typeof i.confirm !== 'string' || i.confirm.trim() !== CONFIRM_WORD) return `Digite ${CONFIRM_WORD} (em maiúsculas) para confirmar.`
  if (i.savedBackup !== true) return 'Marque “Baixei e guardei o backup” antes de excluir.'
  if (typeof i.backupSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.backupSha256)) return 'Baixe o backup (passo 1) antes de excluir.'
  return null
}
