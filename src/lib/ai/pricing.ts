/**
 * Preços por milhão de tokens (USD), API Anthropic — tabela de referência (set/2026).
 * Usada só para ESTIMAR custo nos logs; a fatura oficial é a do console da Anthropic.
 * Escrita em cache (TTL 5 min) = 1,25 × entrada; leitura em cache conforme tabela do modelo.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

export function estimateCostUsd(model: string | undefined, u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | null {
  const key = Object.keys(PRICES).find((k) => model?.startsWith(k))
  if (!key) return null
  const p = PRICES[key]
  const M = 1_000_000
  return ((u.inputTokens ?? 0) * p.input + (u.cacheWriteTokens ?? 0) * p.input * 1.25 + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.outputTokens ?? 0) * p.output) / M
}
