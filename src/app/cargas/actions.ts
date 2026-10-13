'use server'

import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { dtSec } from '@/components/format'
import { canonicalCountry } from '@/lib/countries'
import { parseBrNumber, parseMm } from '@/domain/brNumber'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db, schema } from '@/db'
import { validateLoad } from '@/domain/load'
import { resolveLogistics, withRuleLimit } from '@/domain/logisticsRules'
import { loadDocSchema } from '@/domain/schemas'
import type { LoadDoc, SpaceSnapshot } from '@/domain/types'
import { fitNone } from '@/domain/noEquipment'
import { DEFAULT_COURIER_DIVISOR, isNoEquipment, isService, noneSpace, serviceFromMode, ShipmentService, TYPE_INFO, versionSpaceColumns } from '@/domain/shipmentType'
import { assertUser, AuthError } from '@/lib/auth'
import { can } from '@/lib/roles'
import { INCOTERMS } from '@/lib/constants'
import { logAudit } from '@/lib/audit'
import { lockPackagingVersions } from '@/lib/catalog'
import { evaluateDoc, packagingIds } from '@/lib/planEval'
import { containerSpace, limitSnapshot, vehicleSpace } from '@/lib/snapshots'
import { unitNoun } from '@/lib/units'
import { canAccessPlan, canAccessVersion } from '@/lib/access'
import { Area, AREAS, AreaUser, canAccessArea } from '@/lib/areas'
import { computeLoadPricing, refreezeCommission } from '@/lib/loadPricing'
import { autoPlanName, normalizeOrderRef, orderRefLabel } from '@/lib/orderRef'
import { placeValue } from '@/lib/places'
import { parseMoney, PaymentTerms, paymentTermsErrors } from '@/domain/paymentTerms'
import { VEHICLE_LENGTH_LIMITS, withVehicleLength } from '@/domain/vehicleLength'
import { planUndoApproval, UndoApprovalBlock } from '@/domain/approval'
import { commissionAgentId } from '@/domain/pricing'

export interface NewPlanState {
  error?: string
  values?: Record<string, string>
}


const evaluate = evaluateDoc

export async function createPlanAction(_: NewPlanState, fd: FormData): Promise<NewPlanState> {
  const me = await assertUser('editPlans')
  const values = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))
  // perfis marcados (vários com o mesmo nome): voltam todos ao formulário se houver erro
  values.profiles = fd.getAll('profiles').map(String).join(',')
  const get = (k: string) => String(fd.get(k) ?? '').trim()
  let customerId = Number(get('customerId'))
  const newCustomer = get('newCustomer')
  // país: só da lista (qualquer grafia é convertida para o nome oficial em português)
  const country = canonicalCountry(get('country')) ?? ''
  const incoterm = get('incoterm')
  // tipo de envio (com ou sem equipamento); pedidos antigos do formulário mandam só a modalidade
  const service: ShipmentService = isService(get('service')) ? (get('service') as ShipmentService) : serviceFromMode(get('mode'))
  const mode = TYPE_INFO[service].mode
  const equipment = get('equipment')
  const name = get('name')
  // área do pedido: só as do usuário (ADMIN: todas)
  const area = (get('area') || 'EXPORT') as Area
  if (!AREAS.includes(area) || !canAccessArea(me, area)) return { error: 'Área inválida para o seu usuário.', values }
  if (!country) return { error: get('country') ? `País "${get('country')}" não reconhecido: escolha da lista.` : 'Informe o país de destino.', values }
  if (!INCOTERMS.includes(incoterm)) return { error: 'Selecione o Incoterm.', values }
  const [kind, idStr] = equipment.split(':')
  const eqId = Number(idStr)
  let space: SpaceSnapshot | undefined
  if (isNoEquipment(service)) {
    // sem equipamento: piso virtual; paletes com altura máxima, courier com divisor volumétrico
    // números no formato brasileiro (ponto = milhar, vírgula = decimal; "1,8 m" = 1.800 mm)
    const hIn = parseMm(get('maxHeightMm'))
    const divIn = parseBrNumber(get('courierDivisor'))
    if (Number.isNaN(hIn)) return { error: `Altura "${get('maxHeightMm')}" inválida: use o formato brasileiro (ex.: 1.800 ou 1,8 m).`, values }
    if (Number.isNaN(divIn)) return { error: `Divisor "${get('courierDivisor')}" inválido: use o formato brasileiro (ex.: 5.000).`, values }
    const h = hIn ?? TYPE_INFO[service].defaultHeightMm ?? 2000
    const div = divIn ?? DEFAULT_COURIER_DIVISOR
    if (service !== 'COURIER' && (h < 300 || h > 4000 || !Number.isInteger(h))) return { error: `Altura máxima do palete carregado: ${get('maxHeightMm') || h} — deve ficar entre 300 e 4.000 mm (ex.: 1.800 ou 1,8 m).`, values }
    if (service === 'COURIER' && (div < 1000 || div > 10000 || !Number.isInteger(div))) return { error: 'Divisor volumétrico entre 1.000 e 10.000.', values }
    space = noneSpace(service, { maxHeightMm: h, courierDivisor: div })
  } else if (kind === 'CONTAINER' && (service === 'FCL' || service === 'AIR_ULD')) {
    const c = await db.query.containerTypes.findFirst({ where: and(eq(schema.containerTypes.id, eqId), eq(schema.containerTypes.active, true)) })
    // ULD só no aéreo; contêiner marítimo só no marítimo
    space = c && (c.transportMode === 'AIR') === (service === 'AIR_ULD') ? containerSpace(c) : undefined
  } else if (kind === 'VEHICLE' && service === 'ROAD') {
    const v = await db.query.vehicleTypes.findFirst({ where: and(eq(schema.vehicleTypes.id, eqId), eq(schema.vehicleTypes.active, true)) })
    space = v && v.carrierKind !== 'CHASSIS' ? vehicleSpace(v) : undefined
  }
  if (!space) return { error: service === 'FCL' ? 'Selecione um contêiner.' : service === 'AIR_ULD' ? 'Selecione uma ULD aérea.' : 'Selecione um veículo.', values }
  const profileIds = isNoEquipment(service) ? [] : fd.getAll('profiles').map(Number).filter(Number.isInteger)
  const profiles = profileIds.length ? await db.select().from(schema.constraintProfiles).where(inArray(schema.constraintProfiles.id, profileIds)) : []

  const originPlace = placeValue(get('originPlace'))
  const destinationPlace = placeValue(get('destinationPlace'))
  const customerAddress = placeValue(get('customerAddress'))
  // validações ANTES de gravar qualquer coisa (um erro aqui não deixa cliente novo criado)
  // comprimento útil real do caminhão (opcional; não altera o cadastro do veículo)
  const lengthMm = parseMm(get('lengthMm'))
  if (Number.isNaN(lengthMm)) return { error: `Comprimento "${get('lengthMm')}" inválido: use o formato brasileiro (ex.: 15.300 ou 15,3 m).`, values }
  if (lengthMm != null && space.kind === 'VEHICLE' && (lengthMm < VEHICLE_LENGTH_LIMITS.min || lengthMm > VEHICLE_LENGTH_LIMITS.max || !Number.isInteger(lengthMm)))
    return { error: `Comprimento do caminhão entre ${VEHICLE_LENGTH_LIMITS.min} e ${VEHICLE_LENGTH_LIMITS.max} mm.`, values }
  // transportadora (opcional): "CÓDIGO — Nome", o código ou o nome
  let transportCompanyId: number | null = null
  // "seguir sem cadastrar": a transportadora informada fica só nas observações do pedido
  let unregisteredCompany: string | null = null
  const tcq = get('transportCompany')
  if (tcq) {
    const all = await db.select().from(schema.transportCompanies)
    const code = tcq.split(' — ')[0].trim().toLowerCase()
    const hit = all.find((c) => c.code.toLowerCase() === code) ?? all.find((c) => c.name.toLowerCase() === tcq.toLowerCase())
    if (hit) transportCompanyId = hit.id
    else if (get('transportSkip') === '1') unregisteredCompany = tcq.slice(0, 120)
    else return { error: `Transportadora "${tcq}" não cadastrada: cadastre-a ou escolha "Seguir sem cadastrar".`, values }
  }
  if (!customerId && !newCustomer) return { error: 'Selecione ou informe o cliente.', values }
  // agente da carga: o escolhido no formulário (vazio = sem agente); sem o campo, o do cadastro do cliente
  let agentId: number | null = null
  if (fd.has('agentId')) agentId = Number(get('agentId')) || null
  else if (customerId) agentId = (await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId) }))?.agentId ?? null
  // regra logística central (modalidade + destino): peso bruto máximo da carga como limite da carga
  // (sem equipamento: sem limite de carga — como no planejador de paletes mistos)
  const limits = isNoEquipment(service) || !mode ? [] : withRuleLimit(profiles.map(limitSnapshot), resolveLogistics({ mode, destination: country }))
  const doc0: LoadDoc = { space, limits, packs: {}, pallets: {}, units: [] }
  const doc = lengthMm != null ? withVehicleLength(doc0, lengthMm) : doc0
  const ev = evaluate(doc)
  const planId = await db.transaction(async (tx) => {
    if (!customerId) {
      ;[{ id: customerId }] = await tx
        .insert(schema.customers)
        .values({ name: newCustomer, country, address: customerAddress, createdBy: me.id, updatedBy: me.id })
        .returning({ id: schema.customers.id })
    } else if (customerAddress) {
      // cliente sem endereço no cadastro: guarda o informado (não sobrescreve um existente)
      await tx.update(schema.customers).set({ address: customerAddress, updatedAt: new Date(), updatedBy: me.id }).where(and(eq(schema.customers.id, customerId), isNull(schema.customers.address)))
    }
    const [sh] = await tx
      .insert(schema.shipments)
      .values({ customerId, orderRef: normalizeOrderRef(get('orderRef')), destinationCountry: country, incoterm, mode, service, area, originPlace, destinationPlace, customerAddress, notes: [get('notes'), unregisteredCompany ? `Transportadora (não cadastrada): ${unregisteredCompany}` : ''].filter(Boolean).join('\n') || null, createdBy: me.id, updatedBy: me.id })
      .returning({ id: schema.shipments.id })
    const [lp] = await tx
      .insert(schema.loadPlans)
      .values({ shipmentId: sh.id, name: name || autoPlanName(normalizeOrderRef(get('orderRef')), space.code, country, area), transportCompanyId, agentId, createdBy: me.id, updatedBy: me.id })
      .returning({ id: schema.loadPlans.id })
    await tx.insert(schema.loadPlanVersions).values({
      loadPlanId: lp.id,
      version: 1,
      status: 'DRAFT',
      ...versionSpaceColumns(space),
      document: doc,
      summary: ev.stored,
      issues: ev.issues,
      criticalCount: ev.critical,
      warningCount: ev.warning,
      changelog: 'Criação',
      createdBy: me.id,
      updatedBy: me.id,
    })
    return lp.id
  })
  await logAudit('load_plan', planId, 'create', me.id, { space: space.code, service })
  revalidatePath('/')
  // atalho "Criar com IA": o editor abre e o assistente executa o texto guardado no navegador;
  // sem equipamento: abre direto o planejador de paletes mistos / volumes
  redirect(fd.get('ia') === '1' ? `/cargas/${planId}?ia=1` : isNoEquipment(service) ? `/cargas/${planId}?montar=1` : `/cargas/${planId}`)
}

/** Versão da carga — só se o usuário trabalha na área do pedido (senão, como se não existisse). */
async function getVersion(versionId: number, u: AreaUser) {
  if (!(await canAccessVersion(u, versionId))) return undefined
  return db.query.loadPlanVersions.findFirst({ where: eq(schema.loadPlanVersions.id, versionId) })
}

/** Valida o documento vindo do cliente e remove snapshots não usados. */
function prepareDoc(raw: unknown): { doc: LoadDoc } | { error: string } {
  const parsed = loadDocSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return { error: `Documento inválido: ${i?.path.join('.')} — ${i?.message}` }
  }
  // envio sem equipamento: o piso virtual sempre do tamanho do conteúdo
  let doc = parsed.data as LoadDoc
  for (const u of doc.units) {
    if (u.kind === 'PALLET' && !doc.pallets[u.palletKey]) return { error: 'Unidade com palete inexistente.' }
    if (u.kind === 'PACKAGE' && !doc.packs[u.packId]) return { error: 'Unidade com embalagem inexistente.' }
  }
  const usedP = new Set(doc.units.flatMap((u) => (u.kind === 'PALLET' ? [u.palletKey] : [])))
  const usedK = new Set(doc.units.flatMap((u) => (u.kind === 'PACKAGE' ? [u.packId] : [])))
  doc.pallets = Object.fromEntries(Object.entries(doc.pallets).filter(([k]) => usedP.has(k)))
  doc.packs = Object.fromEntries(Object.entries(doc.packs).filter(([k]) => usedK.has(k)))
  doc = fitNone(doc)
  return { doc }
}

/**
 * Pedido em várias unidades (contêineres/veículos): grava TUDO numa transação — a 1ª unidade na
 * versão em rascunho aberta e as demais como novas cargas do MESMO envio/pedido. Se qualquer parte
 * falhar, nada é gravado (a composição anterior fica intacta).
 */
export async function saveMultiUnitAction(
  versionId: number,
  raws: unknown[],
  changelog: string,
  expectedUpdatedAt?: string,
): Promise<{ ok?: boolean; error?: string; planIds?: number[]; updatedAt?: string }> {
  const me = await assertUser('editPlans')
  if (!Array.isArray(raws) || raws.length < 2 || raws.length > 20) return { error: 'Proposta inválida (2 a 20 unidades).' }
  const v = await getVersion(versionId, me)
  if (!v) return { error: 'Versão não encontrada.' }
  if (v.status !== 'DRAFT') return { error: 'Somente versões em rascunho podem ser editadas. Crie uma nova versão.' }
  if (expectedUpdatedAt && v.updatedAt.toISOString() !== expectedUpdatedAt)
    return { error: 'Esta versão foi salva por outra pessoa depois que você a abriu. Recarregue a página (nada foi gravado).' }
  const docs: LoadDoc[] = []
  for (const [i, raw] of raws.entries()) {
    const p = prepareDoc(raw)
    if ('error' in p) return { error: `Unidade ${i + 1}: ${p.error} Nada foi gravado.` }
    if (!p.doc.units.length) return { error: `Unidade ${i + 1} vazia. Nada foi gravado.` }
    docs.push(p.doc)
  }
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, v.loadPlanId) })
  if (!plan) return { error: 'Carga não encontrada.' }
  const siblings = await db.select({ id: schema.loadPlans.id, name: schema.loadPlans.name }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, plan.shipmentId))
  // numeração das unidades novas a partir do MAIOR número já usado ("… · Contêiner 3"): nunca repete nome,
  // mesmo depois de excluir uma unidade do meio
  const usedNums = siblings.map((x) => Number(/ (\d+)$/.exec(x.name)?.[1] ?? 0))
  const startNum = Math.max(siblings.length, ...usedNums)
  const now = new Date()
  const note = changelog.trim() || `Pedido dividido em ${docs.length} unidades (1ª cheia, remanente na última)`
  let planIds: number[]
  try {
    planIds = await db.transaction(async (tx) => {
      const ev0 = evaluate(docs[0])
      await tx
        .update(schema.loadPlanVersions)
        .set({
          document: docs[0],
          ...versionSpaceColumns(docs[0].space),
          summary: ev0.stored,
          issues: ev0.issues,
          criticalCount: ev0.critical,
          warningCount: ev0.warning,
          changelog: [v.changelog, note].filter(Boolean).join('\n'),
          updatedBy: me.id,
          updatedAt: now,
        })
        .where(eq(schema.loadPlanVersions.id, versionId))
      const ids = [plan.id]
      for (const [i, doc] of docs.slice(1).entries()) {
        const n = startNum + i + 1
        const ev = evaluate(doc)
        const [lp] = await tx
          .insert(schema.loadPlans)
          .values({ shipmentId: plan.shipmentId, name: `${plan.name} · ${unitNoun(doc.space)} ${n}`, agentId: plan.agentId, transportCompanyId: plan.transportCompanyId, createdBy: me.id, updatedBy: me.id })
          .returning({ id: schema.loadPlans.id })
        await tx.insert(schema.loadPlanVersions).values({
          loadPlanId: lp.id,
          version: 1,
          status: 'DRAFT',
          spaceKind: doc.space.kind,
          spaceTypeId: doc.space.typeId,
          document: doc,
          summary: ev.stored,
          issues: ev.issues,
          criticalCount: ev.critical,
          warningCount: ev.warning,
          changelog: `Criada pela divisão do pedido (unidade ${n}, a partir da carga #${plan.id})`,
          createdBy: me.id,
          updatedBy: me.id,
        })
        ids.push(lp.id)
      }
      return ids
    })
  } catch (e) {
    console.error('[pedido multiunidade]', e)
    return { error: 'Não foi possível gravar as unidades. Nada foi alterado.' }
  }
  await lockPackagingVersions(docs.flatMap(packagingIds))
  await logAudit('load_plan', plan.id, 'split_units', me.id, { units: docs.length, planIds })
  revalidatePath('/')
  return { ok: true, planIds, updatedAt: now.toISOString() }
}

/**
 * Carga com seguimento de exportação (pedido confirmado) não pode ser excluída: a FK de export_operation
 * não tem cascade e o seguimento/histórico se perderia. Primeiro desfaz-se a confirmação no seguimento.
 */
async function hasExportOperation(planId: number) {
  const op = await db.query.exportOperations.findFirst({ columns: { id: true }, where: eq(schema.exportOperations.loadPlanId, planId) })
  return Boolean(op)
}
const EXPORT_OP_DELETE_ERROR = 'Não é possível excluir esta carga: o pedido foi confirmado e ela está em Exportações em curso. Desfaça a confirmação no seguimento (possível enquanto o status for “Pedido confirmado”) e tente de novo.'

/**
 * Exclui uma unidade (carga) de um pedido com várias. Só quando o pedido continua com outra unidade
 * e nenhuma versão desta foi enviada para revisão ou aprovada.
 */
export async function deleteUnitAction(planId: number) {
  const me = await assertUser('editPlans')
  if (!(await canAccessPlan(me, planId))) return
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
  if (!plan) return
  const siblings = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, plan.shipmentId)).orderBy(schema.loadPlans.id)
  const versions = await db.select().from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.loadPlanId, planId))
  // pedido confirmado (Exportações em curso): a página da carga mostra o aviso de ?erro=seguimento
  if (await hasExportOperation(planId)) redirect(`/cargas/${planId}?erro=seguimento`)
  if (siblings.length < 2 || versions.some((x) => x.status !== 'DRAFT')) redirect(`/cargas/${planId}?erro=excluir`)
  const vIds = versions.map((x) => x.id)
  await db.transaction(async (tx) => {
    if (vIds.length) {
      const convs = await tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(inArray(schema.aiConversations.loadPlanVersionId, vIds))
      const cIds = convs.map((c) => c.id)
      if (cIds.length) {
        await tx.delete(schema.aiToolCalls).where(inArray(schema.aiToolCalls.conversationId, cIds))
        await tx.delete(schema.aiMessages).where(inArray(schema.aiMessages.conversationId, cIds))
        await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.id, cIds))
      }
      await tx.delete(schema.loadPlanVersions).where(inArray(schema.loadPlanVersions.id, vIds))
    }
    await tx.delete(schema.loadPlans).where(eq(schema.loadPlans.id, planId))
  })
  await logAudit('load_plan', planId, 'delete_unit', me.id, { shipmentId: plan.shipmentId, versions: versions.length })
  revalidatePath('/')
  redirect(`/cargas/${siblings.find((s) => s.id !== planId)!.id}`)
}

/**
 * Exclui uma carga inteira (todas as versões e conversas do assistente) a partir da página principal.
 * A tela pede uma confirmação antes.
 * Carga com versão APROVADA: só quem pode aprovar. Se era a única unidade do pedido, o pedido sai junto
 * (o cliente fica). Fica registrado na auditoria.
 */
export async function deletePlanAction(planId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
    if (!plan) return { ok: false, error: 'Carga não encontrada.' }
    const versions = await db.select().from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.loadPlanId, planId))
    if (versions.some((x) => x.status === 'APPROVED') && !can.approve(me.role)) return { ok: false, error: 'Esta carga tem versão aprovada: só um gerente/administrador pode excluí-la.' }
    if (await hasExportOperation(planId)) return { ok: false, error: EXPORT_OP_DELETE_ERROR }
    const siblings = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, plan.shipmentId))
    const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) })
    const vIds = versions.map((x) => x.id)
    await db.transaction(async (tx) => {
      if (vIds.length) {
        const convs = await tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(inArray(schema.aiConversations.loadPlanVersionId, vIds))
        const cIds = convs.map((c) => c.id)
        if (cIds.length) {
          await tx.delete(schema.aiToolCalls).where(inArray(schema.aiToolCalls.conversationId, cIds))
          await tx.delete(schema.aiMessages).where(inArray(schema.aiMessages.conversationId, cIds))
          await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.id, cIds))
        }
        await tx.delete(schema.loadPlanVersions).where(inArray(schema.loadPlanVersions.id, vIds))
      }
      await tx.delete(schema.loadPlans).where(eq(schema.loadPlans.id, planId))
      // última unidade do pedido: o pedido (envio) sai junto
      if (siblings.length <= 1) await tx.delete(schema.shipments).where(eq(schema.shipments.id, plan.shipmentId))
    })
    await logAudit('load_plan', planId, 'delete', me.id, {
      name: plan.name,
      shipmentId: plan.shipmentId,
      orderRef: shipment?.orderRef ?? null,
      versions: versions.map((x) => ({ version: x.version, status: x.status })),
      shipmentDeleted: siblings.length <= 1,
    })
    revalidatePath('/')
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[excluir carga]', e)
    return { ok: false, error: 'Não foi possível excluir a carga. Nada foi alterado.' }
  }
}

/** Salva o documento na versão (somente RASCUNHO). Valida no servidor e grava resumo + alertas. */
export async function saveVersionAction(
  versionId: number,
  raw: unknown,
  changelog: string,
  expectedUpdatedAt?: string,
): Promise<{ ok?: boolean; error?: string; critical?: number; updatedAt?: string; conflict?: boolean }> {
  const me = await assertUser('editPlans')
  const v = await getVersion(versionId, me)
  if (!v) return { error: 'Versão não encontrada.' }
  if (v.status !== 'DRAFT') return { error: 'Somente versões em rascunho podem ser editadas. Crie uma nova versão.' }
  // concorrência otimista: não sobrescreve o que outro usuário salvou depois que esta tela foi aberta
  if (expectedUpdatedAt && v.updatedAt.toISOString() !== expectedUpdatedAt) {
    const who = v.updatedBy ? await db.query.users.findFirst({ where: eq(schema.users.id, v.updatedBy) }) : undefined
    return {
      conflict: true,
      error: `Esta versão foi salva por ${who?.name ?? 'outro usuário'} em ${dtSec(v.updatedAt)} depois que você a abriu. Recarregue a página para ver as alterações (as suas não foram gravadas).`,
    }
  }
  const holder = await lockedByOther(v.loadPlanId, me.id)
  if (holder) return { error: `Esta carga está sendo editada por ${holder}. Suas alterações não foram gravadas.` }
  const prep = prepareDoc(raw)
  if ('error' in prep) return prep
  const doc = prep.doc
  // o tipo do envio não muda na edição (com equipamento ↔ sem equipamento)
  if ((v.spaceKind === 'NONE') !== (doc.space.kind === 'NONE') || (doc.space.kind === 'NONE' && v.document.space.service !== doc.space.service))
    return { error: 'O tipo de envio não pode ser trocado na edição. Crie uma carga nova em Nova carga.' }

  const ev = evaluate(doc)
  const log = [v.changelog, changelog.trim()].filter(Boolean).join('\n')
  const now = new Date()
  const saved = await db
    .update(schema.loadPlanVersions)
    .set({
      document: doc,
      ...versionSpaceColumns(doc.space),
      summary: ev.stored,
      issues: ev.issues,
      criticalCount: ev.critical,
      warningCount: ev.warning,
      changelog: log,
      updatedBy: me.id,
      updatedAt: now,
    })
    // só grava se a versão AINDA é rascunho (se foi aprovada/enviada nesse meio-tempo, nada é sobrescrito)
    .where(and(eq(schema.loadPlanVersions.id, versionId), eq(schema.loadPlanVersions.status, 'DRAFT')))
    .returning({ id: schema.loadPlanVersions.id })
  if (!saved.length) return { error: 'A versão deixou de ser rascunho (enviada para revisão ou aprovada) enquanto você editava: suas alterações NÃO foram gravadas. Crie uma nova versão para continuar.', conflict: true }
  await lockPackagingVersions(packagingIds(doc))
  await logAudit('load_plan_version', versionId, 'save', me.id, { units: doc.units.length, changelog: changelog.trim() || null })
  return { ok: true, critical: ev.critical, updatedAt: now.toISOString() }
}

/** Cria V(n+1) como rascunho copiando a versão indicada. Versões aprovadas nunca são editadas. */
export async function newVersionAction(versionId: number) {
  const me = await assertUser('editPlans')
  const v = await getVersion(versionId, me)
  if (!v) return
  const [last] = await db
    .select({ version: schema.loadPlanVersions.version })
    .from(schema.loadPlanVersions)
    .where(eq(schema.loadPlanVersions.loadPlanId, v.loadPlanId))
    .orderBy(desc(schema.loadPlanVersions.version))
    .limit(1)
  // clique duplo: se uma versão nova acabou de ser criada a partir desta (≤ 30 s), abre ela em vez de criar outra
  const recent = await db.query.loadPlanVersions.findFirst({ where: and(eq(schema.loadPlanVersions.loadPlanId, v.loadPlanId), eq(schema.loadPlanVersions.version, last.version)) })
  if (recent && recent.id !== v.id && recent.status === 'DRAFT' && recent.changelog === `Criada a partir da V${v.version}` && Date.now() - recent.createdAt.getTime() < 30_000)
    redirect(`/cargas/${v.loadPlanId}?v=${recent.version}`)
  const version = last.version + 1
  const created = await db.insert(schema.loadPlanVersions).values({
    loadPlanId: v.loadPlanId,
    version,
    status: 'DRAFT',
    spaceKind: v.spaceKind,
    spaceTypeId: v.spaceTypeId,
    document: v.document,
    summary: v.summary,
    issues: v.issues,
    criticalCount: v.criticalCount,
    warningCount: v.warningCount,
    changelog: `Criada a partir da V${v.version}`,
    createdBy: me.id,
    updatedBy: me.id,
  })
    // dois cliques ao mesmo tempo: o segundo não dá erro, só abre a versão criada pelo primeiro
    .onConflictDoNothing()
    .returning({ id: schema.loadPlanVersions.id })
  if (!created.length) redirect(`/cargas/${v.loadPlanId}?v=${version}`)
  await logAudit('load_plan', v.loadPlanId, 'new_version', me.id, { from: v.version, to: version })
  revalidatePath('/')
  redirect(`/cargas/${v.loadPlanId}?v=${version}`)
}

export async function submitForReviewAction(versionId: number) {
  const me = await assertUser('editPlans')
  const v = await getVersion(versionId, me)
  if (!v || v.status !== 'DRAFT') return
  if (await lockedByOther(v.loadPlanId, me.id)) redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=emedicao`)
  // composição não finalizada: unidades fora da carga (zona de trabalho) precisam ser reposicionadas ou retiradas
  if (validateLoad(v.document).issues.some((i) => i.code === 'OUTSIDE_LOAD')) redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=fora`)
  await db.update(schema.loadPlanVersions).set({ status: 'IN_REVIEW', updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.loadPlanVersions.id, versionId))
  await logAudit('load_plan_version', versionId, 'submit_review', me.id)
  revalidatePath('/')
  redirect(`/cargas/${v.loadPlanId}?v=${v.version}`)
}

export async function returnToDraftAction(versionId: number) {
  const me = await assertUser('approve')
  const v = await getVersion(versionId, me)
  if (!v || v.status !== 'IN_REVIEW') return
  await db.update(schema.loadPlanVersions).set({ status: 'DRAFT', updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.loadPlanVersions.id, versionId))
  await logAudit('load_plan_version', versionId, 'return_draft', me.id)
  revalidatePath('/')
  redirect(`/cargas/${v.loadPlanId}?v=${v.version}`)
}

export async function approveAction(versionId: number) {
  const me = await assertUser('approve')
  const v = await getVersion(versionId, me)
  if (!v || (v.status !== 'DRAFT' && v.status !== 'IN_REVIEW')) return
  if (await lockedByOther(v.loadPlanId, me.id)) redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=emedicao`)
  // revalida no servidor com o documento salvo (nunca confiar no contador salvo)
  const ev = evaluate(v.document)
  if (ev.critical > 0 || v.document.units.length === 0) {
    redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=${ev.critical > 0 ? 'critico' : 'vazia'}`)
  }
  // preços congelados na aprovação: a partir daqui a tabela de preços não muda esta versão
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, v.loadPlanId) })
  const shipment = plan ? await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) }) : undefined
  const pricing = await computeLoadPricing(v.document, shipment, plan)
  // exportação: não aprova com produto SEM PREÇO (o preço congelaria vazio)
  if (shipment?.area === 'EXPORT') {
    const noPrice = Object.entries(pricing.lines).filter(([, r]) => r.unitUsd == null).map(([sku]) => sku)
    if (noPrice.length) redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=sempreco&skus=${encodeURIComponent(noPrice.join(','))}`)
  }
  await db.transaction(async (tx) => {
    await tx
      .update(schema.loadPlanVersions)
      .set({ status: 'SUPERSEDED' })
      .where(and(eq(schema.loadPlanVersions.loadPlanId, v.loadPlanId), eq(schema.loadPlanVersions.status, 'APPROVED'), ne(schema.loadPlanVersions.id, v.id)))
    await tx
      .update(schema.loadPlanVersions)
      .set({ status: 'APPROVED', approvedBy: me.id, approvedAt: new Date(), issues: ev.issues, criticalCount: 0, warningCount: ev.warning, pricing })
      .where(eq(schema.loadPlanVersions.id, v.id))
  })
  await logAudit('load_plan_version', versionId, 'approve', me.id, { version: v.version })
  revalidatePath('/')
  redirect(`/cargas/${v.loadPlanId}?v=${v.version}`)
}

/** motivo do bloqueio → código ?erro= da página da carga (mensagens em cargas/[id]/page.tsx) */
const UNDO_APPROVAL_ERRO: Record<UndoApprovalBlock, string> = {
  not_found: 'desfazerstatus',
  not_approved: 'desfazerstatus',
  not_latest: 'desfazerversao',
  export_operation: 'desfazerseguimento',
}

/**
 * Desfaz a aprovação: a versão APROVADA volta para RASCUNHO (editável de novo, preços ao vivo) e, se esta
 * aprovação tinha substituído outra, a última versão SUBSTITUÍDA volta a ser a aprovada (com os preços
 * congelados dela). Só a última versão da carga e só sem seguimento de exportação (pedido confirmado).
 * As cotações já emitidas continuam no histórico. Decisão (pura) em src/domain/approval.ts.
 */
export async function undoApprovalAction(versionId: number) {
  // qualquer usuário que edita cargas pode desfazer (aprovar continua só para gerente/admin)
  const me = await assertUser('editPlans')
  const v = await getVersion(versionId, me)
  if (!v) return
  // alertas recalculados como num salvamento de rascunho (a aprovação gravou os do momento)
  const ev = evaluate(v.document)
  const r = await db.transaction(async (tx) => {
    // trava a carga (FOR UPDATE): serializa com "Confirmar pedido" (confirmOrder trava a mesma linha e
    // confere de novo a versão aprovada) e com a criação de versão/operação (a FK espera esta trava)
    await tx.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.id, v.loadPlanId)).for('update')
    // trava as versões da carga: ninguém aprova no meio
    const versions = await tx
      .select({ id: schema.loadPlanVersions.id, version: schema.loadPlanVersions.version, status: schema.loadPlanVersions.status, approvedAt: schema.loadPlanVersions.approvedAt })
      .from(schema.loadPlanVersions)
      .where(eq(schema.loadPlanVersions.loadPlanId, v.loadPlanId))
      .for('update')
    // lido depois das travas: uma confirmação concorrente já terminou (e aparece aqui) ou espera esta transação
    const [op] = await tx.select({ id: schema.exportOperations.id }).from(schema.exportOperations).where(eq(schema.exportOperations.loadPlanId, v.loadPlanId)).limit(1)
    const plan = planUndoApproval(versions, v.id, { exportOperation: Boolean(op) })
    if (!plan.ok) return plan
    await tx
      .update(schema.loadPlanVersions)
      .set({ status: 'DRAFT', approvedBy: null, approvedAt: null, pricing: null, issues: ev.issues, criticalCount: ev.critical, warningCount: ev.warning, updatedBy: me.id, updatedAt: new Date() })
      .where(and(eq(schema.loadPlanVersions.id, v.id), eq(schema.loadPlanVersions.status, 'APPROVED')))
    if (plan.restore)
      await tx
        .update(schema.loadPlanVersions)
        .set({ status: 'APPROVED' })
        .where(and(eq(schema.loadPlanVersions.id, plan.restore.id), eq(schema.loadPlanVersions.status, 'SUPERSEDED')))
    return plan
  })
  if (!r.ok) redirect(`/cargas/${v.loadPlanId}?v=${v.version}&erro=${UNDO_APPROVAL_ERRO[r.reason]}`)
  // agente trocado enquanto a versão restaurada estava substituída: a aprovada volta com a comissão do
  // agente atual (mesma base congelada), como em qualquer troca de agente depois da aprovação. Compara
  // com o agente que a comissão aplicaria (inativo = sem agente, salvo se já era o congelado): agente
  // inativo na carga e congelado sem agente NÃO é troca. Preços congelados antes do módulo de agentes
  // (sem o campo agent) ficam como estão.
  let recommissioned = 0
  if (r.restore) {
    const [rv, plan] = await Promise.all([
      db.query.loadPlanVersions.findFirst({ columns: { pricing: true }, where: eq(schema.loadPlanVersions.id, r.restore.id) }),
      db.query.loadPlans.findFirst({ columns: { agentId: true }, where: eq(schema.loadPlans.id, v.loadPlanId) }),
    ])
    const agentRow = plan?.agentId ? await db.query.agents.findFirst({ columns: { id: true, active: true }, where: eq(schema.agents.id, plan.agentId) }) : null
    const frozenAgentId = rv?.pricing?.agent?.id ?? null
    if (rv?.pricing && 'agent' in rv.pricing && frozenAgentId !== commissionAgentId(agentRow, frozenAgentId)) recommissioned = await refreezeCommission([v.loadPlanId])
  }
  await logAudit('load_plan_version', versionId, 'unapprove', me.id, { version: v.version, restored: r.restore?.id ?? null, restoredVersion: r.restore?.version ?? null, ...(recommissioned ? { recommissioned } : {}) })
  revalidatePath('/')
  revalidatePath(`/cargas/${v.loadPlanId}`)
  redirect(`/cargas/${v.loadPlanId}?v=${v.version}`)
}

/**
 * Altera a referência do pedido (Proforma / Pedido) de uma carga já criada. Vale para o pedido inteiro
 * (todas as unidades). Os nomes automáticos das cargas acompanham ("Proforma 12 — 40GP"); nomes
 * digitados à mão não mudam. Fica registrado na auditoria.
 */
export async function updateOrderRefAction(planId: number, value: string): Promise<{ ok: true; orderRef: string | null } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
    if (!plan) return { ok: false, error: 'Carga não encontrada.' }
    const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) })
    if (!shipment) return { ok: false, error: 'Pedido não encontrado.' }
    const next = normalizeOrderRef(value)
    const prev = shipment.orderRef
    if (next === prev) return { ok: true, orderRef: next }
    const siblings = await db.select().from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, shipment.id))
    const renamed: { id: number; from: string; to: string }[] = []
    for (const p of siblings) {
      const [v] = await db.select({ doc: schema.loadPlanVersions.document }).from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.loadPlanId, p.id)).orderBy(desc(schema.loadPlanVersions.version)).limit(1)
      const code = v?.doc.space.code ?? ''
      // nome automático antigo (com ou sem sufixo de unidade " · Contêiner 2") → novo nome automático
      const oldBase = autoPlanName(prev, code, shipment.destinationCountry, shipment.area)
      // nomes gerados pelas regras anteriores ("Pedido 192.26 — 40GP", "Pedido Proforma 192.26 — 40GP")
      const legacy = prev ? [`Pedido ${prev} — ${code}`, `Pedido Proforma ${prev} — ${code}`, `${prev} — ${code}`] : []
      const base = [oldBase, ...legacy].find((b) => b && (p.name === b || p.name.startsWith(`${b} · `)))
      if (!base) continue
      const to = autoPlanName(next, code, shipment.destinationCountry, shipment.area) + p.name.slice(base.length)
      if (to !== p.name) renamed.push({ id: p.id, from: p.name, to })
    }
    await db.transaction(async (tx) => {
      await tx.update(schema.shipments).set({ orderRef: next, updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.shipments.id, shipment.id))
      for (const r of renamed) await tx.update(schema.loadPlans).set({ name: r.to, updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.loadPlans.id, r.id))
    })
    await logAudit('shipment', shipment.id, 'order_ref', me.id, { from: prev, to: next, label: next ? orderRefLabel(next, shipment.area) : null, renamed })
    revalidatePath('/')
    for (const p of siblings) revalidatePath(`/cargas/${p.id}`)
    return { ok: true, orderRef: next }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * Proforma e transporte de uma carga: transportadora (por código ou nome), frete e seguro em USD e
 * condições de pagamento. Não muda a composição (vale para qualquer versão). Fica na auditoria.
 */
export async function updateCommercialAction(
  planId: number,
  input: { agentId?: number | null; transportCompany: string; freightUsd: string; insuranceUsd: string; paymentTerms: PaymentTerms | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
    if (!plan) return { ok: false, error: 'Carga não encontrada.' }
    const usd = (v: string, label: string) => {
      const n = parseMoney(v)
      if (n == null) return null
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new Error(`${label}: valor inválido.`)
      return Math.round(n * 100) / 100
    }
    const freightUsd = usd(input.freightUsd, 'Frete')
    const insuranceUsd = usd(input.insuranceUsd, 'Seguro')
    let terms: PaymentTerms | null = null
    if (input.paymentTerms) {
      const t = input.paymentTerms
      terms = { advancePct: Number(t.advancePct), balanceWhen: Number(t.advancePct) >= 100 ? null : t.balanceWhen ?? null, days: t.days != null && String(t.days) !== '' ? Number(t.days) : null, note: t.note?.trim() || null }
      const errs = paymentTermsErrors(terms)
      if (errs.length) return { ok: false, error: errs.join(' ') }
    }
    // transportadora: "CÓDIGO — Nome", só o código ou o nome (sem diferenciar maiúsculas)
    let transportCompanyId: number | null = null
    const q = input.transportCompany.trim()
    if (q) {
      const all = await db.select().from(schema.transportCompanies)
      const code = q.split(' — ')[0].trim().toLowerCase()
      const hit = all.find((c) => c.code.toLowerCase() === code) ?? all.find((c) => c.name.toLowerCase() === q.toLowerCase())
      if (!hit) return { ok: false, error: `Transportadora "${q}" não encontrada (cadastre em Cadastros → Transportadoras).` }
      transportCompanyId = hit.id
    }
    // agente da carga (comissão): só um agente cadastrado; null = sem agente
    let agentId = plan.agentId
    if (input.agentId !== undefined) {
      agentId = input.agentId == null ? null : Number(input.agentId)
      if (agentId != null && !(await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }))) return { ok: false, error: 'Agente não encontrado.' }
    }
    await db.update(schema.loadPlans).set({ agentId, transportCompanyId, freightUsd, insuranceUsd, paymentTerms: terms, updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.loadPlans.id, planId))
    await logAudit('load_plan', planId, 'commercial', me.id, {
      from: { agentId: plan.agentId, transportCompanyId: plan.transportCompanyId, freightUsd: plan.freightUsd, insuranceUsd: plan.insuranceUsd, paymentTerms: plan.paymentTerms },
      to: { agentId, transportCompanyId, freightUsd, insuranceUsd, paymentTerms: terms },
    })
    // agente trocado: a versão aprovada é re-congelada com a comissão do novo agente
    if (agentId !== plan.agentId) {
      const n = await refreezeCommission([planId])
      if (n) await logAudit('load_plan', planId, 'recommission', me.id, { from: plan.agentId, to: agentId })
    }
    revalidatePath(`/cargas/${planId}`)
    revalidatePath('/')
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    if (e instanceof Error) return { ok: false, error: e.message }
    throw e
  }
}

/** Legenda de uma foto do carregamento. */
export async function updatePhotoCaptionAction(planId: number, photoId: number, caption: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const c = caption.trim().slice(0, 200) || null
    await db.update(schema.loadPhotos).set({ caption: c }).where(and(eq(schema.loadPhotos.id, photoId), eq(schema.loadPhotos.loadPlanId, planId)))
    revalidatePath(`/cargas/${planId}`)
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    throw e
  }
}

/** Exclui uma foto do carregamento (fica na auditoria). */
export async function deletePhotoAction(planId: number, photoId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const del = await db.delete(schema.loadPhotos).where(and(eq(schema.loadPhotos.id, photoId), eq(schema.loadPhotos.loadPlanId, planId))).returning({ id: schema.loadPhotos.id, caption: schema.loadPhotos.caption })
    if (!del.length) return { ok: false, error: 'Foto não encontrada.' }
    await logAudit('load_plan', planId, 'photo_delete', me.id, { photoId, caption: del[0].caption })
    revalidatePath(`/cargas/${planId}`)
    return { ok: true }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    throw e
  }
}

/** Cadastro rápido de transportadora a partir da Nova carga (código único + nome). */
export async function quickTransportCompanyAction(input: { code: string; name: string }): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    const code = input.code.trim().slice(0, 40)
    const name = input.name.trim().slice(0, 160)
    if (!code || !name) return { ok: false, error: 'Informe o código e o nome da transportadora.' }
    const all = await db.select().from(schema.transportCompanies)
    if (all.some((c) => c.code.toLowerCase() === code.toLowerCase())) return { ok: false, error: `Já existe uma transportadora com o código "${code}".` }
    const [row] = await db.insert(schema.transportCompanies).values({ code, name, createdBy: me.id, updatedBy: me.id }).returning({ id: schema.transportCompanies.id })
    await logAudit('transport_company', row.id, 'create', me.id, { code, name, via: 'nova carga' })
    return { ok: true, label: `${code} — ${name}` }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    return { ok: false, error: 'Não foi possível cadastrar a transportadora.' }
  }
}

// ---------------------------------------------------------------------------
// BLOQUEIO DE EDIÇÃO: um usuário por vez edita uma carga (renovado a cada minuto; expira em 3 min)
// ---------------------------------------------------------------------------
const LOCK_MS = 3 * 60_000

/** Nome de OUTRO usuário que está editando a carga agora (bloqueio válido), ou null. */
async function lockedByOther(planId: number, myId: number): Promise<string | null> {
  const p = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
  if (!p?.editLockBy || p.editLockBy === myId || !p.editLockAt || Date.now() - p.editLockAt.getTime() > LOCK_MS) return null
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, p.editLockBy) })
  return u?.name ?? 'outro usuário'
}

/** Pega (ou renova) o bloqueio de edição. ok=false: outro usuário está editando (devolve o nome). */
export async function acquireEditLockAction(planId: number): Promise<{ ok: true } | { ok: false; by: string }> {
  const me = await assertUser('editPlans')
  if (!(await canAccessPlan(me, planId))) return { ok: false, by: '—' }
  const now = new Date()
  const cutoff = new Date(now.getTime() - LOCK_MS)
  // atômico: só pega se estiver livre, vencido ou já for meu
  const rows = await db
    .update(schema.loadPlans)
    .set({ editLockBy: me.id, editLockAt: now })
    .where(and(eq(schema.loadPlans.id, planId), or(isNull(schema.loadPlans.editLockBy), eq(schema.loadPlans.editLockBy, me.id), isNull(schema.loadPlans.editLockAt), lt(schema.loadPlans.editLockAt, cutoff))))
    .returning({ id: schema.loadPlans.id })
  if (rows.length) return { ok: true }
  return { ok: false, by: (await lockedByOther(planId, me.id)) ?? 'outro usuário' }
}

/** Libera o bloqueio (ao sair do editor). */
export async function releaseEditLockAction(planId: number): Promise<void> {
  const me = await assertUser('editPlans')
  await db.update(schema.loadPlans).set({ editLockBy: null, editLockAt: null }).where(and(eq(schema.loadPlans.id, planId), eq(schema.loadPlans.editLockBy, me.id)))
}

/**
 * Agente da carga (comissão no preço), gravado NA HORA ao escolher: rascunho → preço recalculado ao vivo;
 * versão aprovada → preços re-congelados com a comissão do novo agente (mesma base). Fica na auditoria.
 */
export async function setPlanAgentAction(planId: number, agentId: number | null): Promise<{ ok: true; recommissioned: number } | { ok: false; error: string }> {
  try {
    const me = await assertUser('editPlans')
    if (!(await canAccessPlan(me, planId))) return { ok: false, error: 'Carga não encontrada.' }
    const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
    if (!plan) return { ok: false, error: 'Carga não encontrada.' }
    if (agentId != null && !(await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }))) return { ok: false, error: 'Agente não encontrado.' }
    if (agentId === plan.agentId) return { ok: true, recommissioned: 0 }
    await db.update(schema.loadPlans).set({ agentId, updatedBy: me.id, updatedAt: new Date() }).where(eq(schema.loadPlans.id, planId))
    const n = await refreezeCommission([planId])
    await logAudit('load_plan', planId, 'agent', me.id, { from: plan.agentId, to: agentId, recommissionedVersions: n })
    revalidatePath(`/cargas/${planId}`)
    revalidatePath('/')
    return { ok: true, recommissioned: n }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[agente da carga]', e)
    return { ok: false, error: 'Não foi possível gravar o agente.' }
  }
}
