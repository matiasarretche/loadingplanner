import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { BALANCE_WHEN_OPTIONS, BalanceWhen } from '@/domain/paymentTerms'
import type { CurrentUser } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { INCOTERMS } from '@/lib/constants'
import { countryNamePt } from '@/lib/countries'
import { loadPricingConfig } from '@/lib/exportPricing'
import { priceListItems } from '@/lib/priceList'
import { assertRate, OrderParseError } from './orderParser'
import { estimateCostUsd } from './pricing'
import { AIConfigError, getProvider, ToolSpec } from './provider'
import { replyLanguage } from './service'

/**
 * Assistente da LISTA DE PREÇOS: transforma o pedido do usuário ("lista em espanhol FOB com o agente X, só
 * silo-bolsa de 9 e 10 pés e Hidrosilo 2 m de 5 a 20 mil litros, 30% antecipado e saldo contra BL") nas
 * opções da tela. Não calcula preço nem gera o PDF: o usuário confere as opções e clica em Gerar.
 */
const SYSTEM = `Você é o assistente da tela "Lista de preços (PDF)" do Pacifil Export Load Planner.
Sua única tarefa: ler o pedido do usuário e chamar set_price_list UMA vez com as opções da lista, usando SOMENTE os valores das listas em <dados>.
Regras:
- Famílias e itens: use os nomes de família e os SKUs exatamente como em <dados>. "skus" só quando o usuário restringir medidas/capacidades/larguras/diâmetros ou MARCAS dentro de uma família; sem restrição, omita "skus" (vão todos os itens das famílias).
- Marca: cada item tem a sua marca (Pacifil, Agromai, Ecobag…). Se o usuário pedir uma marca ("só Ecobag", "Hidroforce Agromai"), escolha só os SKUs dessa marca naquela família; nunca troque a marca de um item. "Pacifil" como nome da empresa ou dentro de "PACIFIL NXT" (tecnologia) NÃO restringe a marca; na dúvida, omita "skus" e pergunte.
- Silo-bolsa: medida em pés (diâmetro) e metros (comprimento); Hidrosilo/Hidroforce: largura (2 m ou 3 m) e capacidade em litros; lonas: largura × comprimento × espessura.
- Categoria: se o usuário citar um país, use a categoria desse país (em <dados>); se citar a categoria, use-a. Sem citação, omita.
- Agente: só se citado (nome parecido com um de <dados>). "sem agente" = agent_id 0.
- Idioma do PDF: es, pt ou en, só se citado ou óbvio pelo cliente/país.
- Condição de pagamento só se citada: % antecipado e quando se paga o saldo (balance_when de <dados>); dias só para DAYS_*.
- Nunca invente preços, categorias, agentes nem condições. O que não estiver claro: omita e pergunte na resposta.
- Responda no idioma de <idioma_resposta>, em no máximo 3 linhas: o que foi ajustado e as dúvidas.`

const SET_PRICE_LIST: ToolSpec = {
  name: 'set_price_list',
  description: 'Entrega as opções da lista de preços (só os campos citados pelo usuário).',
  inputSchema: {
    type: 'object',
    properties: {
      families: { type: 'array', items: { type: 'string' }, maxItems: 30, description: 'nomes das famílias (exatos de <dados>)' },
      skus: { type: 'array', items: { type: 'string' }, maxItems: 400, description: 'itens escolhidos (SKUs de <dados>), só quando o usuário restringiu as medidas ou as marcas' },
      category_id: { type: 'integer' },
      incoterm: { type: 'string', enum: INCOTERMS },
      agent_id: { type: 'integer', description: '0 = sem agente' },
      lang: { type: 'string', enum: ['es', 'pt', 'en'] },
      columns: { type: 'object', properties: { thickness: { type: 'boolean' }, box: { type: 'boolean' }, per_pallet: { type: 'boolean' } }, additionalProperties: false },
      payment: {
        type: 'object',
        properties: { advance_pct: { type: 'number', minimum: 0, maximum: 100 }, balance_when: { type: 'string', enum: BALANCE_WHEN_OPTIONS }, days: { type: 'integer', minimum: 1, maximum: 720 }, note: { type: 'string', maxLength: 300 } },
        required: ['advance_pct'],
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
}

/** opções para a tela (só o que o assistente definiu) */
export interface PriceListPreset {
  families?: string[]
  skus?: string[]
  categoryId?: number
  incoterm?: string
  /** null = sem agente */
  agentId?: number | null
  lang?: 'es' | 'pt' | 'en'
  columns?: { thickness?: boolean; box?: boolean; perPallet?: boolean }
  payment?: { advancePct: number; balanceWhen: BalanceWhen | null; days: number | null; note: string | null }
}

export async function priceListAssist(user: CurrentUser, message: string): Promise<{ text: string; preset: PriceListPreset }> {
  await assertRate(user.id)
  let provider
  try {
    provider = await getProvider()
  } catch (e) {
    if (e instanceof AIConfigError) throw new OrderParseError(`Assistente indisponível: ${e.message}`)
    throw e
  }
  const [cfg, items, agents] = await Promise.all([loadPricingConfig(), priceListItems(), db.select().from(schema.agents).where(eq(schema.agents.active, true))])
  // famílias com preço próprio (as "incluídas", ex.: KIT-HF, não entram na lista)
  const famIds = new Map((await db.select({ id: schema.productFamilies.id, name: schema.productFamilies.name }).from(schema.productFamilies)).map((f) => [f.name, f.id]))
  const priced = items.filter((i) => cfg.familyRule.get(famIds.get(i.family) ?? -1)?.method !== 'INCLUDED')
  const families = [...new Set(priced.map((i) => i.family))]
  const cats = cfg.categories.filter((c) => c.active)
  const countriesOf = (id: number) => [...cfg.countryCategory].filter(([, c]) => c === id).map(([code]) => countryNamePt(code))
  const dados = [
    `FAMÍLIAS: ${families.join(' | ')}`,
    `ITENS (sku · família · marca · subgrupo · descrição):`,
    ...priced.map((i) => `${i.sku} · ${i.family} · ${i.brand} · ${i.sub || '-'} · ${i.name}`),
    `CATEGORIAS (id · nome · países):`,
    ...cats.map((c) => `${c.id} · ${c.name} · ${countriesOf(c.id).join(', ') || '(sem países)'}`),
    `AGENTES (id · nome): ${agents.map((a) => `${a.id} · ${a.name}`).join(' | ') || '(nenhum)'}`,
    `INCOTERMS: ${INCOTERMS.join(', ')}`,
    `BALANCE_WHEN: BEFORE_SHIPMENT (antes do embarque), AGAINST_DOCS (contra cópia dos documentos/BL), ON_ARRIVAL (na chegada), DAYS_AFTER_SHIPMENT (N dias após o embarque), DAYS_AFTER_INVOICE (N dias após a fatura), LC_AT_SIGHT (carta de crédito à vista)`,
  ].join('\n')

  let preset: PriceListPreset = {}
  let result
  try {
    result = await provider.runTurn({
      system: SYSTEM,
      history: [],
      userContent: `<dados>\n${dados}\n</dados>\n<idioma_resposta>${replyLanguage(message)}</idioma_resposta>\n\n${message}`,
      tools: [SET_PRICE_LIST],
      maxToolRounds: 3,
      executeTool: async (name, input) => {
        if (name !== 'set_price_list') return { content: JSON.stringify({ error: `Ferramenta desconhecida: ${name}` }), isError: true }
        const i = input as { families?: string[]; skus?: string[]; category_id?: number; incoterm?: string; agent_id?: number; lang?: string; columns?: { thickness?: boolean; box?: boolean; per_pallet?: boolean }; payment?: { advance_pct: number; balance_when?: string; days?: number; note?: string } }
        // só valores que existem: nada inventado passa
        const fams = (i.families ?? []).map((f) => families.find((x) => x.toLowerCase() === String(f).toLowerCase())).filter((x): x is string => Boolean(x))
        const skuSet = new Map(priced.map((x) => [x.sku.toUpperCase(), x]))
        const skus = (i.skus ?? []).map((s) => skuSet.get(String(s).toUpperCase())).filter((x): x is (typeof priced)[number] => Boolean(x))
        const p: PriceListPreset = {}
        if (fams.length || skus.length) p.families = [...new Set([...fams, ...skus.map((x) => x.family)])]
        if (skus.length) p.skus = skus.map((x) => x.sku)
        if (i.category_id != null && cats.some((c) => c.id === i.category_id)) p.categoryId = i.category_id
        if (i.incoterm && INCOTERMS.includes(i.incoterm)) p.incoterm = i.incoterm
        if (i.agent_id === 0) p.agentId = null
        else if (i.agent_id != null && agents.some((a) => a.id === i.agent_id)) p.agentId = i.agent_id
        if (i.lang === 'es' || i.lang === 'pt' || i.lang === 'en') p.lang = i.lang
        if (i.columns) p.columns = { thickness: i.columns.thickness, box: i.columns.box, perPallet: i.columns.per_pallet }
        if (i.payment && Number.isFinite(i.payment.advance_pct)) {
          const bw = BALANCE_WHEN_OPTIONS.find((w) => w === i.payment!.balance_when) ?? null
          p.payment = { advancePct: Math.min(100, Math.max(0, i.payment.advance_pct)), balanceWhen: i.payment.advance_pct >= 100 ? null : bw, days: bw?.startsWith('DAYS_') && i.payment.days ? Math.round(i.payment.days) : null, note: i.payment.note?.slice(0, 300) || null }
        }
        preset = p
        return { content: JSON.stringify({ ok: true, families: p.families?.length ?? 0, skus: p.skus?.length ?? 0 }) }
      },
    })
  } catch (e) {
    await logAudit('ai_order', null, 'error', user.id, { kind: 'price_list', message, error: e instanceof Error ? e.message : String(e) })
    throw new OrderParseError('O serviço de IA não respondeu. Tente novamente em instantes.')
  }
  const cost = result.newTurns.reduce((t, x) => t + (x.usage ? estimateCostUsd(x.usage.model ?? provider.model, x.usage) ?? 0 : 0), 0)
  await logAudit('ai_order', null, 'price_list', user.id, { message, preset, costUsd: Math.round(cost * 1e6) / 1e6 })
  return { text: result.finalText || '(sem resposta)', preset }
}
