import 'server-only'
import { and, count, eq, gte } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import type { CurrentUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { userAreas } from '@/lib/areas'
import { estimateCostUsd } from './pricing'
import { AIConfigError, getProvider, ToolSpec } from './provider'
import { replyLanguage } from './service'
import { executeTool, TOOL_SPECS } from './tools'

/**
 * Assistente do PEDIDO (paletes mistos): interpreta o pedido em linguagem natural e devolve as linhas
 * (SKU + unidades) e, se citados, modalidade / destino / altura máxima. Não monta paletes: quem
 * otimiza é o motor, depois que o usuário revisa as linhas. Só leitura do catálogo; nada é gravado.
 */
const SYSTEM = `Você é o assistente de PEDIDOS do Pacifil Export Load Planner, na tela "Pedido → paletes mistos".
Sua única tarefa: transformar o pedido escrito pelo usuário em linhas (SKU + UNIDADES de produto) e chamar set_order UMA vez no final.
Regras:
- Identifique cada produto com search_products, passando o texto do usuário (com a marca, se houver). O motor aplica a regra de marca (sem marca citada = PACIFIL). Não pergunte a marca quando houver produto Pacifil compatível.
- Se "unambiguous" for false e houver mais de um candidato plausível cuja escolha muda o resultado, NÃO escolha: deixe o item fora de set_order e pergunte, listando as opções (código e descrição).
- Quantidades são UNIDADES de produto (bolsas, hidrosilos, lonas…), não caixas. Se o usuário pedir em PALETES COMPLETOS ("1 pallet completo de X", "2 paletes de X", "um palete cheio", "o máximo que entra num palete"), NÃO pergunte nem calcule: informe o item em full_pallets (sku + nº de paletes). O sistema calcula quantas unidades cabem num palete com a altura máxima e o palete da tela, já contando os acompanhantes (ex.: KIT-HF). Na resposta diga só que foram N palete(s) completo(s) de X, sem citar unidades por palete.
- REGRA DAS LONAS (até 14 m de largura): EXPORTAÇÃO = sempre Lona padrão (lona plana); MERCADO INTERNO = sempre Lona BPF. O motor (search_products) já aplica a regra pela área do envio quando o pedido não cita a linha; não pergunte plana × BPF. Se o pedido citar explicitamente a linha (BPF, Plus, plana), vale o pedido. Lonas acima de 14 m (BigSafe, Big Silo, medidas especiais) não mudam. Se a área não estiver definida (lonaRule no resultado), pergunte se é exportação ou mercado interno.
- Vocabulário da Pacifil: diga "peso líquido" (nunca "peso neto"), também em espanhol.
- Nunca calcule pesos, caixas, paletes nem capacidades. Não inclua acompanhantes obrigatórios (ex.: KIT-HF do Hydroforce): o motor os adiciona sozinho.
- Envio por courier/paqueteria (DHL, FedEx, UPS, "por paquete", "caixas soltas sem palete") = mode COURIER: não pergunte altura nem palete.
- Caminhão/camión consolidado, carga fracionada rodoviária ou LTL = mode ROAD (não LCL); LCL é só o consolidado marítimo.
- Se o usuário citar modalidade (aéreo, LCL/consolidado marítimo, contêiner/FCL, rodoviário/caminhão, "só paletes", courier), país de destino ou altura máxima do palete, informe em set_order (altura em mm).
- Se o texto não tiver nenhum produto identificável, não chame set_order: explique o que faltou.
- Responda no idioma de <idioma_resposta>, em no máximo 3 linhas: o que foi adicionado e as dúvidas pendentes. Não liste de novo todas as linhas (a tela mostra).`

const SET_ORDER: ToolSpec = {
  name: 'set_order',
  description: 'Entrega o pedido interpretado: linhas SKU + unidades e/ou paletes completos por SKU (só produtos confirmados por search_products) e, se citados, modalidade, destino e altura máxima do palete.',
  inputSchema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        maxItems: 60,
        items: { type: 'object', properties: { sku: { type: 'string' }, units: { type: 'integer', minimum: 1 } }, required: ['sku', 'units'], additionalProperties: false },
      },
      full_pallets: {
        type: 'array',
        maxItems: 60,
        description: 'pedidos em paletes completos: o sistema calcula as unidades por palete com a altura/palete da tela',
        items: { type: 'object', properties: { sku: { type: 'string' }, pallets: { type: 'integer', minimum: 1 } }, required: ['sku', 'pallets'], additionalProperties: false },
      },
      mode: { type: 'string', enum: ['FCL', 'LCL', 'AIR', 'ROAD', 'PALLETS_ONLY', 'COURIER'] },
      destination: { type: 'string' },
      max_height_mm: { type: 'integer', minimum: 300, maximum: 4000 },
    },
    required: [],
    additionalProperties: false,
  },
}

export interface ParsedOrder {
  text: string
  lines: { sku: string; units: number }[]
  /** pedidos em paletes completos (unidades calculadas na tela com a altura/palete atuais) */
  fullPallets?: { sku: string; pallets: number }[]
  mode?: 'FCL' | 'LCL' | 'AIR' | 'ROAD' | 'PALLETS_ONLY' | 'COURIER'
  destination?: string
  maxHeightMm?: number
}

export class OrderParseError extends Error {}

const RATE_PER_MIN = Number(process.env.AI_RATE_PER_MIN ?? 8)
const RATE_PER_DAY = Number(process.env.AI_RATE_PER_DAY ?? 300)

/** Limite por usuário (mesmos valores do assistente de cargas), contado na auditoria. */
export async function assertRate(userId: number) {
  const since = async (ms: number) => {
    const [r] = await db
      .select({ n: count() })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.userId, userId), eq(s.auditLog.entity, 'ai_order'), gte(s.auditLog.at, new Date(Date.now() - ms))))
    return r?.n ?? 0
  }
  if ((await since(60_000)) >= RATE_PER_MIN) throw new OrderParseError('Muitas solicitações em pouco tempo. Aguarde um minuto.')
  if ((await since(86_400_000)) >= RATE_PER_DAY) throw new OrderParseError('Limite diário do assistente atingido.')
}

export async function parseOrder(user: CurrentUser, message: string): Promise<ParsedOrder> {
  await assertRate(user.id)
  let provider
  try {
    provider = await getProvider()
  } catch (e) {
    if (e instanceof AIConfigError) throw new OrderParseError(`Assistente indisponível: ${e.message}`)
    throw e
  }
  // contexto mínimo para as tools de catálogo (não há carga nesta tela)
  const areas = userAreas(user)
  const ctx = { user, area: areas.length === 1 ? areas[0] : undefined, draft: { space: { kind: 'CONTAINER', typeId: 0, code: '-', name: '-', inner: { l: 1, w: 1, h: 1 }, door: { w: 1, h: 1 }, tareKg: 0, maxPayloadKg: null, maxGrossKg: null, floorLoadKgPerM: null, source: null, verification: 'ESTIMATED' }, limits: [], packs: {}, pallets: {}, units: [] } } as Parameters<typeof executeTool>[0]
  let order: Omit<ParsedOrder, 'text'> | null = null
  const tools = [TOOL_SPECS.find((t) => t.name === 'search_products')!, SET_ORDER]
  let result
  try {
    result = await provider.runTurn({
      system: SYSTEM,
      history: [],
      userContent: `<idioma_resposta>${replyLanguage(message)}</idioma_resposta>\n\n${message}`,
      tools,
      maxToolRounds: 8,
      executeTool: async (name, input) => {
        if (name === 'search_products') {
          const r = await executeTool(ctx, name, input)
          return { content: JSON.stringify(r.result), isError: !r.ok }
        }
        if (name === 'set_order') {
          const i = input as { lines?: { sku: string; units: number }[]; full_pallets?: { sku: string; pallets: number }[]; mode?: ParsedOrder['mode']; destination?: string; max_height_mm?: number }
          const lines = (i.lines ?? []).filter((l) => typeof l.sku === 'string' && Number.isInteger(l.units) && l.units > 0).slice(0, 60)
          const fullPallets = (i.full_pallets ?? []).filter((l) => typeof l.sku === 'string' && Number.isInteger(l.pallets) && l.pallets > 0 && l.pallets <= 200).slice(0, 60)
          order = { lines, fullPallets, mode: i.mode, destination: i.destination?.slice(0, 60), maxHeightMm: i.max_height_mm }
          return { content: JSON.stringify({ ok: true, lines: lines.length }) }
        }
        return { content: JSON.stringify({ error: `Ferramenta desconhecida: ${name}` }), isError: true }
      },
    })
  } catch (e) {
    await logAudit('ai_order', null, 'error', user.id, { message, error: e instanceof Error ? e.message : String(e) })
    throw new OrderParseError('O serviço de IA não respondeu. Tente novamente em instantes.')
  }
  const cost = result.newTurns.reduce((t, x) => t + (x.usage ? estimateCostUsd(x.usage.model ?? provider.model, x.usage) ?? 0 : 0), 0)
  const o = order as Omit<ParsedOrder, 'text'> | null
  await logAudit('ai_order', null, 'parse', user.id, { message, lines: o?.lines ?? [], fullPallets: o?.fullPallets ?? [], costUsd: Math.round(cost * 1e6) / 1e6 })
  return { text: result.finalText || '(sem resposta)', lines: o?.lines ?? [], fullPallets: o?.fullPallets ?? [], mode: o?.mode, destination: o?.destination, maxHeightMm: o?.maxHeightMm }
}
