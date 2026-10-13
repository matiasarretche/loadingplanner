/**
 * REGRA COMERCIAL DAS LONAS (até 14 m de largura):
 *   - EXPORTAÇÃO      → sempre Lona padrão (lona plana)
 *   - MERCADO INTERNO → sempre Lona BPF
 * Vale quando o pedido não cita a linha. Se o cliente pedir uma linha explicitamente ("BPF", "Plus",
 * "plana"…), vale o pedido. Lonas acima de 14 m (BigSafe, Big Silo, medidas especiais…) não mudam.
 */
export type BusinessArea = 'EXPORT' | 'DOMESTIC'

export const LONA_RULE_MAX_WIDTH_M = 14
const LINE_FOR: Record<BusinessArea, 'Lona padrão' | 'Lona BPF'> = { EXPORT: 'Lona padrão', DOMESTIC: 'Lona BPF' }
type RuleLine = 'Lona padrão' | 'Lona BPF' | 'Lona Plus'

export const LONA_RULE_TEXT = 'Lonas de até 14 m de largura: exportação = Lona padrão (lona plana); mercado interno = Lona BPF.'

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/**
 * Largura da lona em metros a partir do nome ("Lona BPF 8 × 50 m × 125 µm" → 8). É o primeiro número
 * seguido de "× <número>": assim o "X3" de "Lona BPF Plus X3 10 × 50 m" não atrapalha (→ 10).
 */
export function lonaWidthM(name: string): number | null {
  const m = /^lona\b.*?(\d+(?:[.,]\d+)?)\s*[×x]\s*\d/i.exec(name.trim())
  return m ? Number(m[1].replace(',', '.')) : null
}

/** Linha da lona pelo nome (só as linhas sujeitas à regra). */
function ruleLine(name: string): RuleLine | null {
  const n = norm(name)
  if (n.startsWith('lona padrao')) return 'Lona padrão'
  if (n.startsWith('lona bpf')) return 'Lona BPF'
  if (n.startsWith('lona plus')) return 'Lona Plus'
  return null
}

/** Produto sujeito à regra (Lona padrão / BPF / Plus de até 14 m)? */
export function isRuleLona(name: string): boolean {
  const w = lonaWidthM(name)
  return ruleLine(name) != null && w != null && w <= LONA_RULE_MAX_WIDTH_M
}

/** O texto do pedido cita explicitamente uma linha de lona? (então vale o que foi pedido) */
export function citesLonaLine(text: string): boolean {
  const t = norm(text)
  return /\bbpf\b|\bplus\b|\blp\b|\bplana\b|\bpadrao\b|\bstandard\b|\bstd\b|bigsafe|big safe|big silo/.test(t)
}

/** O produto é aceito pela regra para a área? (fora da regra: sempre aceito) */
export function allowedByLonaRule(name: string, area: BusinessArea): boolean {
  if (!isRuleLona(name)) return true
  return ruleLine(name) === LINE_FOR[area]
}

/**
 * Catálogo que a busca oferece para a área: sem linha citada no pedido, tira as lonas da outra linha — menos
 * as que o pedido cita pelo CÓDIGO (escolha explícita; os códigos oficiais são numéricos e não dizem a linha).
 */
export function filterByLonaRule<T extends { sku: string; name: string }>(items: T[], area: BusinessArea, query: string): T[] {
  if (citesLonaLine(query)) return items
  const cited = new Set(query.toUpperCase().split(/[^0-9A-Z-]+/).filter(Boolean))
  return items.filter((e) => cited.has(e.sku.toUpperCase()) || allowedByLonaRule(e.name, area))
}

/**
 * Lona equivalente (mesma largura × comprimento × espessura) na linha da área — usada quando a área
 * do pedido muda na revisão. Sem equivalente cadastrado: null.
 */
export function lonaForArea<T extends { sku: string; name: string }>(item: T, area: BusinessArea, catalog: T[]): T | null {
  if (!isRuleLona(item.name) || allowedByLonaRule(item.name, area)) return null
  const line = ruleLine(item.name)!
  const target = norm(item.name).replace(norm(line), norm(LINE_FOR[area]))
  return catalog.find((c) => norm(c.name) === target) ?? null
}
