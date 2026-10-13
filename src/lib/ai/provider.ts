/**
 * Abstração do provedor de IA. O resto do sistema (AIService, tools, UI) não conhece o SDK concreto:
 * trocar de provedor/modelo = implementar `AIProvider` e selecionar por AI_PROVIDER / AI_MODEL.
 */

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema do input */
  inputSchema: Record<string, unknown>
}

export interface ToolCallResult {
  /** JSON serializado devolvido ao modelo */
  content: string
  isError?: boolean
}

/** Mensagem no formato NATIVO do provedor; guardada e devolvida sem alterações (append-only). */
export interface StoredTurn {
  role: string
  content: unknown
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; model?: string }
  stopReason?: string
}

/** Parte da mensagem do usuário: texto, imagem ou PDF (anexos de pedidos). */
export type UserPart = { type: 'text'; text: string } | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string } | { type: 'pdf'; data: string; title?: string }

export interface ProviderTurnRequest {
  system: string
  /** histórico anterior (StoredTurn.content/role) exatamente como foi gravado */
  history: StoredTurn[]
  /** nova mensagem do usuário (texto + contexto da carga), ou partes com anexos (imagens/PDF em base64) */
  userContent: string | UserPart[]
  tools: ToolSpec[]
  executeTool: (name: string, input: unknown) => Promise<ToolCallResult>
  /** limite de rodadas de tools por mensagem do usuário */
  maxToolRounds: number
  /** esforço do modelo nesta chamada (padrão: AI_EFFORT do servidor) */
  effort?: 'low' | 'medium' | 'high'
}

export interface ProviderTurnResult {
  /** turnos a anexar ao histórico, na ordem (user, assistant, tool results, assistant…) */
  newTurns: StoredTurn[]
  finalText: string
  stopReason: string
}

export interface AIProvider {
  readonly name: string
  readonly model: string
  runTurn(req: ProviderTurnRequest): Promise<ProviderTurnResult>
}

export class AIConfigError extends Error {}

/** Seleciona o provedor por variável de ambiente (somente no servidor). */
export async function getProvider(): Promise<AIProvider> {
  const name = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase()
  if (name === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic')
    return new AnthropicProvider()
  }
  throw new AIConfigError(`Provedor de IA desconhecido: ${name}`)
}
