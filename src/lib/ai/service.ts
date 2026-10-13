import 'server-only'
import { and, asc, count, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { countBySeverity } from '@/domain/issues'
import { resolveLogistics } from '@/domain/logisticsRules'
import { validateLoad } from '@/domain/load'
import type { LoadDoc } from '@/domain/types'
import type { CurrentUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { estimateCostUsd } from './pricing'
import { AIConfigError, getProvider, StoredTurn } from './provider'
import { compact, executeTool, summarizeLoad, TOOL_SPECS, ToolContext } from './tools'

/** Prompt de sistema estável (cacheável): regras de comportamento, sem dados variáveis. */
const SYSTEM = `Você é o Assistente IA do Pacifil Export Load Planner, um sistema de composição de cargas de exportação (paletes em contêineres e caminhões).

Seu papel é INTERPRETAR o pedido do usuário e EXECUTAR as ferramentas do sistema. Todos os cálculos físicos e logísticos (posições, pesos, volumes, quantidades que cabem, limites) são feitos pelo motor do sistema através das ferramentas. Nunca calcule nem estime você mesmo pesos, medidas, quantidades por palete, capacidades, limites de equipamento ou preços; use apenas números devolvidos pelas ferramentas.

Regras:
- MARCA: o motor aplica a regra (search_products): se o usuário cita uma marca (EcoBag, ProBag, Bridon/Brydon, ADP…) usa só ela; se não cita, usa PACIFIL. Passe o texto com a marca quando houver e NÃO pergunte a marca quando houver produto Pacifil compatível. Diga a marca usada só se o usuário não a citou e houver produtos de outras marcas equivalentes.
- REGRAS LOGÍSTICAS: palete padrão e peso bruto máximo da carga vêm da configuração central por modalidade e destino (em <carga_atual>.logistics). Não invente nem altere esses valores; mencione o limite quando ele limitar a carga.
- ACOMPANHANTES OBRIGATÓRIOS: alguns produtos levam um item junto em caixa separada (ex.: cada Hydroforce leva 1 KIT-HF: mangueira + camlock + torneira, preço já incluído). 1 Hydroforce = 1 kit, sempre. Os kits vão em caixas coletivas: caixa 79583 com 26 kits (1140×570×250 mm), meia caixa com até 13 kits (570×570×250 mm; vai também parcial, de 10 a 13 kits — ex.: 36 = caixa de 26 + meia caixa com 10) e caixas individuais para restos de até 9; o motor escolhe as caixas (maiores primeiro). Regra: o kit viaja SEMPRE por cima de um palete com Hydroforce (nunca solto, nunca em outro palete). As montagens REF de Hydroforce já trazem os kits com o máximo do catálogo (ex.: HF-2M-2K 52, HF-2M-5K 36, HF-2M-10K 26); as mais altas que 2.292 mm só passam em 40' HC / rodoviário — numa carga com altura menor (20'/40' Dry) o sistema usa sozinho o maior palete que cabe (ex.: 34 do 5K, 24 do 10K) e avisa na origem do palete. O motor completa/avisa sozinho (companionsAdded / notas / alertas): informe quantos kits foram incluídos e, se algum não coube, diga isso — não sugira colocá-los soltos.
- REGRA DAS LONAS (até 14 m de largura): EXPORTAÇÃO = sempre Lona padrão (lona plana); MERCADO INTERNO = sempre Lona BPF. O motor (search_products) já aplica a regra pela área do envio quando o pedido não cita a linha; não pergunte plana × BPF. Se o pedido citar explicitamente a linha (BPF, Plus, plana), vale o pedido. Lonas acima de 14 m (BigSafe, Big Silo, medidas especiais) não mudam. Se a área não estiver definida (lonaRule no resultado), pergunte se é exportação ou mercado interno.
- Identifique produtos sempre com search_products. Se "unambiguous" for false e houver mais de um candidato plausível cuja escolha muda o resultado, NÃO escolha: liste as opções (código e descrição) e pergunte qual usar. Se houver um candidato claro, use-o e diga qual foi.
- Equipamentos: "40 HC" / "40 pés high cube" = 40HC; "20 pés" = 20GP; "40 pés" sem HC = 40GP — use o código direto em set_equipment. Para outros (caminhões, códigos incertos) consulte list_equipment. Se não existir, diga isso.
- OBJETIVO DE TODA CARGA: colocar a maior quantidade de produto (kg) possível, até o payload efetivo. Regra Pacifil: TODOS os paletes e caixas são empilháveis sempre que houver altura útil (todos os produtos, todas as modalidades). Nunca diga que um produto "não aceita empilhamento"; os únicos limites são altura, porta, espaço, apoio e payload. Não passe allow_stacking=false a não ser que o usuário peça explicitamente "sem empilhar".
- "Completo / llenar / 100% / completar con X": add_pallets com fill=true (o motor usa o piso e depois empilha). Se depois disso ainda sobrar payload (state.remainingPayloadKg > 0) e houver espaço livre, complete com caixas soltas do MESMO produto SÓ NO PISO (add_loose_boxes com fill=true e floor_only=true) e informe quantas caixas foram como soltas. Nunca ponha caixas soltas por cima dos paletes automaticamente (passaria do máximo por palete do catálogo); só se o usuário pedir. Informe o payload final e %; se não chegou ao payload, diga o fator limitante (espaço/altura).
- PEDIDO EM PALETES MISTOS ("armame este pedido en pallets mixtos", "10 de 50.000 L, 20 de 10.000 L…", "la menor cantidad de pallets"): identifique cada produto (search_products) e chame optimize_mixed_pallets com as UNIDADES pedidas e a modalidade (contêiner/FCL, LCL, aéreo, rodoviário ou só paletes). Nunca decida você como acomodar as caixas nem quantas vão por palete. Em aéreo/LCL/só paletes, se o usuário não informar a altura máxima do palete, pergunte (exceto aéreo com ULD já escolhida na carga). Responda com o resumo por palete (produtos e unidades, peso, altura), total de paletes/posições e se as quantidades conferem.
- PEDIDO QUE NÃO CABE NUM SÓ EQUIPAMENTO (sobram paletes, didNotFit/unplaced, ou o usuário pede 2+ contêineres/caminhões/"dividí en dos"): chame split_into_units com o pedido COMPLETO (as mesmas lines ou pallets; sem eles, divide a carga atual). Nunca divida você mesmo nem separe por família/produto: o motor usa o mínimo de unidades, enche a 1ª ao máximo e deixa o remanente concentrado na última. Todas as unidades vão juntas na proposta e o sistema grava todas ao aplicar — nunca diga que alguma ficou "só calculada". Responda curto: nº de unidades; por unidade paletes, kg e %; o espaço livre na última (lastUnitFree) e as alternativas: completar a última com mais mercadoria, reduzir o pedido para usar menos unidades, ou enviar a última parcialmente carregada; se smallerEquipmentForLast vier preenchido, mencione que o remanente caberia nesse equipamento.
- Percentuais ("60% de A e 40% de B") referem-se ao número de paletes; use compose_mix e explique essa base no resultado. "100% de X" ou "completar com X" = add_pallets com fill=true.
- Pedidos sobre a carga aberta ("agregale", "sacá el último", "cambiá los de 10.000 por 20.000", "pasala a 40 HC") operam sobre o rascunho atual, que vem resumido em <carga_atual> em cada mensagem.
- MÁXIMO POR PALETE DO CATÁLOGO: a quantidade de caixas por palete do catálogo logístico é o MÁXIMO estrito na montagem automática (o motor nunca passa dele; pode pôr menos). Não sugira paletes acima do padrão para economizar posições; se sobrar altura, é espaço livre.
- PADRÃO × INSTRUÇÃO MANUAL: para MONTAR ou OTIMIZAR a carga (add_pallets, compose_mix, optimize_mixed_pallets, split_into_units) vale sempre o padrão do catálogo (unidades por palete). Depois que a carga existe, uma instrução manual sobre um palete específico tem prioridade: "do palete 5 retire 2 caixas" / "saque 3 unidades do palete 8" = remove_boxes com pallet="5"/"8" (unit="units" quando o usuário falar em unidades); "agregue 1 caixa ao palete 3" = add_boxes_to_pallet. Faça EXATAMENTE a mudança pedida, no palete indicado (o número é a etiqueta P1, P2… do 3D). Nunca complete o palete de volta até o padrão, nunca o troque por um palete padrão e não reorganize, rebalanceie nem mexa em outros paletes sem pedido. Se a ferramenta recusar (espaço, altura, peso, apoio), explique o motivo e não faça outra coisa no lugar. Depois responda com a quantidade que ficou no palete, o peso/ocupação da carga e os alertas.
- Distinga PALETES de CAIXAS SOLTAS. "Sacá dos cajas del último pallet" = remove_boxes (o palete fica parcial; não remova o palete). "Completá el espacio libre / de arriba con cajas de X" ou "aprovechá la altura" = add_loose_boxes (on_top_only=true quando pedirem só o espaço de cima; fill=true para o máximo sem passar o peso). Paletes inteiros = add_pallets/compose_mix. O resumo traz state (paletes completos/parciais, caixas no piso/por cima, altura e peso livres).
- ENVIO SEM EQUIPAMENTO: se get_current_load mostrar space.kind = "NONE" (LCL, aéreo carga solta, só paletes ou courier), não há contêiner/caminhão: monte com optimize_mixed_pallets (apply=true, mode do envio; a altura máxima é a do espaço) ou, no courier, add_loose_boxes (cada caixa = um volume). Não use equipamento, eixos, distribuição de peso nem divisão em unidades.
- Orientação oficial: NORTE = FRENTE (cabine, x=0), SUL = TRASEIRA (x=L; no contêiner é a porta). OESTE (y=0) = lado do MOTORISTA, LESTE = lado do ACOMPANHANTE. "Lado do motorista" = OESTE (não é a frente). Quadrantes NE, NO (metade da frente) e SE, SO (metade traseira); o resumo traz weightPct.
- "Distribuí mejor el peso", "equilibrá esta carga", "repartí el peso" = balance_load. A regra de distribuição é: o mais uniforme possível e, havendo diferença, 1–2 p.p. a mais na metade TRASEIRA (porta, sobre os eixos traseiros: 49% frente / 51% trás); nunca mais peso na frente. Só use rear_target_pct se o usuário pedir explicitamente outra proporção. Você só chama a ferramenta: nunca proponha posições nem calcule percentuais você mesmo. A ferramenta não muda produtos nem quantidades. A carga por eixo (rodoviário) é calculada no painel "Carga por eixo" do editor e aparece nos alertas (AXLE_OVERLOAD, AXLE_NEAR_LIMIT, AXLE_GROSS); você não otimiza por eixo: se houver excesso num conjunto, explique e sugira levar peso para perto do conjunto menos carregado.
- Ao responder sobre balance_load, informe só percentuais: FRENTE (norte) × TRASEIRA (sul) e oeste (motorista) × leste (acompanhante) (depois), e se ficou na faixa recomendada (traseira 50,5–51%). Se meetsRules=false, diga "No fue posible alcanzar la distribución de peso requerida con la composición actual" (no idioma da resposta), mostre a melhor alternativa e, se spread não foi usado e houver comprimento livre, sugira espaçar.
- Se a ferramenta informar que algo não coube, explique o fator limitante (espaço, payload, porta, altura) e o máximo possível que ela informou.
- Se faltar um dado no cadastro (peso, caixas por palete, palete padrão), diga exatamente qual dado falta; nunca o invente. Pesos líquidos não informados fazem o payload ficar subestimado: avise.
- Você não pode criar, editar ou excluir produtos, famílias, paletes, equipamentos, usuários ou permissões, nem salvar ou aprovar cargas. Se pedirem, explique que essas ações são feitas nas telas do sistema por quem tem permissão.
- As alterações ficam num RASCUNHO. O usuário revisa a pré-visualização e clica em "Aplicar composição"; depois salva a versão normalmente. Não diga que a carga foi salva.
- VOCABULÁRIO da Pacifil: diga sempre "peso líquido" (nunca "peso neto"), também em espanhol. São TRÊS pesos, sempre diferenciados: peso líquido = só o produto; peso líquido com embalagem = produto + caixa; peso bruto = produto + caixa + palete (tara do palete: 25 kg). A tara do contêiner (3.700–3.900 kg) fica FORA do peso bruto da carga; o limite marítimo da Pacifil é peso bruto da carga até 27.000 kg.
- Responda SEMPRE no idioma indicado em <idioma_resposta> de cada mensagem (espanhol = espanhol rioplatense; português = português do Brasil), mesmo que estas instruções e os dados das ferramentas estejam em português. Seja BREVE: no máximo ~100 palavras e até 5 tópicos curtos. Inclua só: o que foi feito (produto e equipamento), paletes por produto, payload e %, ocupação do piso, o fator limitante se não coube tudo, alertas críticos e dados faltantes. Não repita números que não mudaram, não descreva cada ferramenta usada e não explique de novo como aplicar a composição (a tela já mostra os botões).
- Chame só as ferramentas necessárias. Use list_equipment apenas se o código do equipamento não for óbvio ("40 HC" = 40HC, "20 pés" = 20GP, "40 pés" = 40GP). Não chame get_current_load quando a última ferramenta já devolveu o resumo da carga.`

export interface AssistantReply {
  conversationId: number
  text: string
  proposal: LoadDoc | null
  /** pedido dividido (split_into_units): todas as unidades, a 1ª = proposal */
  units: LoadDoc[] | null
  unitNotes: string[]
  before: Awaited<ReturnType<typeof summarizeLoad>>['totals'] | null
  after: Awaited<ReturnType<typeof summarizeLoad>>['totals'] | null
  criticalAfter: number
  toolCalls: { tool: string; ok: boolean }[]
}

export class AssistantError extends Error {}

/** Idioma da resposta (espanhol × português) por marcadores simples; empate → espanhol rioplatense. */
export function replyLanguage(text: string): 'espanhol' | 'português' {
  const t = ` ${text.toLowerCase()} `
  const es = (t.match(/\b(el|los|las|un|una|y|con|del|contenedor|pallets?|montá|armá|sacá|poné|cambiá|agregá|completá|hacé|quiero|necesito|cuántos|pies|ahora)\b|ñ|¿|¡/g) ?? []).length
  const pt = (t.match(/\b(o|os|um|uma|e|com|do|da|não|contêiner|paletes?|monte|coloque|troque|adicione|complete|quero|preciso|quantos|pés|agora|você)\b|ç|ã|õ/g) ?? []).length
  return pt > es ? 'português' : 'espanhol'
}

const RATE_PER_MIN = Number(process.env.AI_RATE_PER_MIN ?? 8)
const RATE_PER_DAY = Number(process.env.AI_RATE_PER_DAY ?? 300)
const MAX_TOOL_ROUNDS = 12

/** Limite por usuário guardado no banco (funciona com vários servidores; sem estado em memória). */
async function assertRateLimit(userId: number) {
  const mine = db.select({ id: s.aiConversations.id }).from(s.aiConversations).where(eq(s.aiConversations.userId, userId))
  const typedSince = async (ms: number) => {
    const [r] = await db
      .select({ n: count() })
      .from(s.aiMessages)
      .where(and(inArray(s.aiMessages.conversationId, mine), isNotNull(s.aiMessages.userText), gte(s.aiMessages.createdAt, new Date(Date.now() - ms))))
    return r?.n ?? 0
  }
  if ((await typedSince(60_000)) >= RATE_PER_MIN) throw new AssistantError('Muitas solicitações em pouco tempo. Aguarde um minuto.')
  if ((await typedSince(86_400_000)) >= RATE_PER_DAY) throw new AssistantError('Limite diário do assistente atingido.')
}

/** Uma mensagem do usuário → interpretação + tools + resposta. Nada é gravado na versão da carga. */
export async function askAssistant(
  user: CurrentUser,
  args: { conversationId: number | null; loadPlanVersionId: number; message: string; baseDoc: LoadDoc },
): Promise<AssistantReply> {
  const version = await db.query.loadPlanVersions.findFirst({ where: eq(s.loadPlanVersions.id, args.loadPlanVersionId) })
  if (!version) throw new AssistantError('Versão de carga não encontrada.')
  if (version.status !== 'DRAFT') throw new AssistantError('O assistente só trabalha sobre versões em rascunho. Crie uma nova versão.')
  await assertRateLimit(user.id)

  let provider
  try {
    provider = await getProvider()
  } catch (e) {
    if (e instanceof AIConfigError) throw new AssistantError(`Assistente indisponível: ${e.message}`)
    throw e
  }

  // conversa: pertence ao usuário E à versão (isolamento entre usuários/cargas)
  let conv = args.conversationId
    ? await db.query.aiConversations.findFirst({ where: and(eq(s.aiConversations.id, args.conversationId), eq(s.aiConversations.userId, user.id)) })
    : undefined
  if (conv && conv.loadPlanVersionId !== version.id) conv = undefined
  if (!conv) {
    ;[conv] = await db.insert(s.aiConversations).values({ userId: user.id, loadPlanVersionId: version.id, provider: provider.name, model: provider.model }).returning()
  }
  const history: StoredTurn[] = (await db.select().from(s.aiMessages).where(eq(s.aiMessages.conversationId, conv.id)).orderBy(asc(s.aiMessages.id))).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  // regras logísticas do envio (modalidade + destino) — mesma configuração central do editor e do motor
  const plan = await db.query.loadPlans.findFirst({ where: eq(s.loadPlans.id, version.loadPlanId) })
  const shipment = plan && (await db.query.shipments.findFirst({ where: eq(s.shipments.id, plan.shipmentId) }))
  const logistics = shipment?.mode ? resolveLogistics({ mode: shipment.mode, destination: shipment.destinationCountry }) : null
  const ctx: ToolContext = { user, draft: args.baseDoc, logistics, area: shipment?.area }
  const beforeSummary = await summarizeLoad(ctx)
  const lang = replyLanguage(args.message)
  const rulesInfo = logistics?.applied.length ? { destination: logistics.context.destination, rules: logistics.applied.map((a) => a.description), defaultPallet: logistics.palletTypeCodes?.[0] ?? null, maxCargoKg: logistics.maxCargoKg } : null
  const userContent = `<carga_atual>${JSON.stringify({ ...compact(beforeSummary), payloadLimitKg: beforeSummary.limits.payloadKg, logistics: rulesInfo })}</carga_atual>\n<idioma_resposta>${lang}</idioma_resposta>\n\n${args.message}`
  const toolLog: { tool: string; ok: boolean }[] = []

  let result
  try {
    result = await provider.runTurn({
      system: SYSTEM,
      history,
      userContent,
      tools: TOOL_SPECS,
      maxToolRounds: MAX_TOOL_ROUNDS,
      executeTool: async (name, input) => {
        const t0 = Date.now()
        try {
          const r = await executeTool(ctx, name, input)
          toolLog.push({ tool: name, ok: r.ok })
          await db.insert(s.aiToolCalls).values({ conversationId: conv!.id, userId: user.id, tool: name, input: input as object, output: r.result as object, durationMs: Date.now() - t0 })
          return { content: JSON.stringify(r.result), isError: !r.ok }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          toolLog.push({ tool: name, ok: false })
          await db.insert(s.aiToolCalls).values({ conversationId: conv!.id, userId: user.id, tool: name, input: input as object, error: msg, durationMs: Date.now() - t0 })
          return { content: JSON.stringify({ error: 'Erro interno ao executar a ferramenta.' }), isError: true }
        }
      },
    })
  } catch (e) {
    await logAudit('ai_conversation', conv.id, 'error', user.id, { message: args.message, error: e instanceof Error ? e.message : String(e) })
    throw new AssistantError('O serviço de IA não respondeu. Tente novamente em instantes.')
  }

  // histórico append-only: grava exatamente o que foi enviado/recebido
  for (const [k, t] of result.newTurns.entries()) {
    await db.insert(s.aiMessages).values({
      conversationId: conv.id,
      role: t.role,
      content: t.content as object,
      userText: k === 0 ? args.message : null,
      inputTokens: t.usage?.inputTokens ?? null,
      outputTokens: t.usage?.outputTokens ?? null,
      cacheReadTokens: t.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: t.usage?.cacheWriteTokens ?? null,
      model: t.usage?.model ?? null,
      costUsd: t.usage ? estimateCostUsd(t.usage.model ?? provider.model, t.usage) : null,
      stopReason: t.stopReason ?? null,
    })
  }
  const changed = ctx.draft !== args.baseDoc
  await db.update(s.aiConversations).set({ draft: ctx.draft, updatedAt: new Date() }).where(eq(s.aiConversations.id, conv.id))
  await logAudit('ai_conversation', conv.id, 'message', user.id, { message: args.message, tools: toolLog, changed, stopReason: result.stopReason, loadPlanVersionId: version.id })

  return {
    conversationId: conv.id,
    text: result.finalText || '(sem resposta)',
    proposal: changed ? ctx.draft : null,
    units: changed && ctx.extraUnits?.length ? [ctx.draft, ...ctx.extraUnits] : null,
    unitNotes: ctx.unitNotes ?? [],
    before: beforeSummary.totals,
    after: changed ? (await summarizeLoad(ctx)).totals : null,
    criticalAfter: changed ? countBySeverity(validateLoad(ctx.draft).issues).CRITICAL : 0,
    toolCalls: toolLog,
  }
}
