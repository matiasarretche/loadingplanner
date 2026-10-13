import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { AIConfigError, AIProvider, ProviderTurnRequest, ProviderTurnResult, StoredTurn, UserPart } from './provider'

type MsgParam = Anthropic.Beta.Messages.BetaMessageParam
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam

/** Partes neutras (texto/imagem/PDF) → blocos da API Messages. */
function toBlocks(parts: UserPart[]): ContentBlock[] {
  return parts.map((p): ContentBlock => {
    if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
    if (p.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data }, ...(p.title ? { title: p.title } : {}) }
    return { type: 'text', text: p.text }
  })
}

/**
 * Provedor Claude (Anthropic). A chave fica só no servidor (ANTHROPIC_API_KEY ou credencial do ambiente).
 * - Modelo: AI_MODEL (padrão claude-sonnet-5-5); esforço: AI_EFFORT (padrão "low").
 * - Fallback no servidor ("default"): se o modelo recusar por política, a API repete com outro modelo.
 * - Histórico append-only: o conteúdo do assistente (inclusive thinking) é devolvido sem edição.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  readonly model = process.env.AI_MODEL || 'claude-sonnet-5-5'
  private client: Anthropic

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new AIConfigError('ANTHROPIC_API_KEY não configurada no servidor.')
    }
    this.client = new Anthropic({ maxRetries: 2, timeout: 120_000 })
  }

  async runTurn(req: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const effort = req.effort ?? ((process.env.AI_EFFORT as 'low' | 'medium' | 'high' | undefined) || 'low')
    const tools: Anthropic.Beta.Messages.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    }))
    const messages: MsgParam[] = req.history.map((t) => ({ role: t.role as MsgParam['role'], content: t.content as MsgParam['content'] }))
    const userContent = typeof req.userContent === 'string' ? req.userContent : toBlocks(req.userContent)
    const newTurns: StoredTurn[] = [{ role: 'user', content: userContent }]
    messages.push({ role: 'user', content: userContent })

    let finalText = ''
    let stopReason = 'end_turn'
    for (let round = 0; round <= req.maxToolRounds; round++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort },
        cache_control: { type: 'ephemeral' },
        system: req.system,
        tools,
        messages,
      })
      stopReason = response.stop_reason ?? 'end_turn'
      messages.push({ role: 'assistant', content: response.content as MsgParam['content'] })
      newTurns.push({
        role: 'assistant',
        content: response.content,
        stopReason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? undefined,
          model: response.model,
        },
      })
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
      if (text) finalText = text

      if (stopReason === 'refusal') {
        finalText = 'Não posso atender esta solicitação.'
        break
      }
      if (stopReason === 'pause_turn') continue
      const calls = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
      if (stopReason !== 'tool_use' || !calls.length) break
      const results: ToolResult[] = []
      if (round === req.maxToolRounds) {
        // fecha os tool_use pendentes para o histórico continuar válido na próxima mensagem
        for (const c of calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Limite de etapas atingido; não executado.', is_error: true })
        newTurns.push({ role: 'user', content: results })
        finalText = 'Parei: muitas etapas para uma única instrução. Tente dividir o pedido em partes menores.'
        stopReason = 'max_tool_rounds'
        break
      }
      for (const c of calls) {
        const r = await req.executeTool(c.name, c.input)
        results.push({ type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })
      }
      // todos os resultados numa única mensagem (permite chamadas paralelas)
      messages.push({ role: 'user', content: results })
      newTurns.push({ role: 'user', content: results })
    }
    return { newTurns, finalText, stopReason }
  }
}
