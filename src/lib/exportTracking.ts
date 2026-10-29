import 'server-only'
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import type { ConfirmContext, ConfirmInput, ExportDetail, ExportEvent, ExportEventKind, ExportEventSource, ExportProduct, ExportRow, ExportSibling, TrackingPatch, TrackingValues } from '@/app/exportacoes/types'
import { DATE_FIELDS, describeChange, etaFrom, ExportStatus, FIELD_LABEL, FieldSource, FieldSources, isActiveStatus, isExportStatus, isIsoDate, PER_UNIT_FIELDS, SummaryVersionInput, todayBR, TRACKING_FIELDS, TrackingField, TrackingSummary, trackingSummaryDto, TrackingValue } from '@/domain/exportTracking'
import { kitBoxLines, kitFamilyOf } from '@/domain/kitBoxes'
import { paymentTermsText, type PaymentTerms } from '@/domain/paymentTerms'
import { transportCompanyLabel } from '@/domain/transportCompany'
import { loadGeometries, loadSummary } from '@/domain/load'
import { proformaTotals } from '@/domain/pricing'
import { serviceOf } from '@/domain/shipmentType'
import type { LoadDoc, PackSnapshot } from '@/domain/types'
import { palletTareBySku } from '@/domain/weights'
import { canAccessArea, type AreaUser } from './areas'
import { avatarRef, AvatarRef } from './avatar'
import { productRank } from './catalog'
import { planValue } from './loadPricing'
import { orderRefLabel } from './orderRef'
import { loadPlanVersion } from './planData'
import { can, canConfirmExports, canEditExports, canSeeExports } from './roles'

/**
 * EXPORTAÇÕES EM CURSO — camada de dados (servidor). Núcleo puro (etapas, datas, alertas, textos do
 * histórico) em src/domain/exportTracking.ts; tipos das telas em src/app/exportacoes/types.ts.
 *
 * PERMISSÕES (puras, em src/lib/roles.ts; reexportadas aqui):
 *   canSeeExports(u)     → ver o módulo: área EXPORTAÇÃO e papel ≠ WAREHOUSE_VIEWER
 *   canEditExports(u)    → editar o seguimento / desfazer a confirmação (+ can.editTracking)
 *   canConfirmExports(u) → confirmar pedidos (+ can.confirmOrder)
 * As funções deste arquivo NÃO conferem quem chama (exceto as de leitura, que recebem o usuário):
 * as Server Actions (src/app/exportacoes/actions.ts) fazem assertUser + área + canAccessPlan antes.
 *
 * UM ÚNICO CAMINHO DE ESCRITA: applyTrackingPatch — usado pela tela agora e por integrações no futuro.
 * Integração futura (armador, freight forwarder, plataforma de rastreio), num job/rota do servidor:
 *
 *   const r = await applyTrackingPatch(
 *     [operationId],                                   // a operação localizada por trackingRef/booking/contêiner
 *     { atd: '2026-10-22', currentLocation: 'Santos', trackingStatus: 'Vessel departed' }, // só o que mudou
 *     { userId: null, source: 'API', provider: 'Maersk', ref: 'MAEU123456' },
 *   )
 *
 *   - mesmas validações da tela; textos longos demais são cortados (na tela, recusados);
 *   - cada valor gravado registra a origem em fieldSources[campo] = { source: 'API', at, provider };
 *   - o histórico (export_event) recebe source 'API' e userId null; lastTrackingUpdate = agora e
 *     trackingProvider/trackingRef são atualizados a cada chamada (mesmo sem mudanças);
 *   - a ETA é recalculada (ETD + trânsito) como na tela; o STATUS nunca avança sozinho: a integração
 *     só manda status se a plataforma informar a etapa explicitamente (decisão do Matías: manual).
 */
export { canConfirmExports, canEditExports, canSeeExports }

type PatchField = keyof TrackingValues
type OpRow = typeof schema.exportOperations.$inferSelect
type EventInsert = typeof schema.exportEvents.$inferInsert

/** quem escreve: usuário (tela) ou integração (API, userId null) */
export interface TrackingActor {
  userId: number | null
  source: 'MANUAL' | 'API'
  /** integração: nome da plataforma/armador (vai para fieldSources e trackingProvider) */
  provider?: string | null
  /** integração: referência do embarque na plataforma (trackingRef) */
  ref?: string | null
}

export type PatchResult = { ok: true; updated: number[]; events: number } | { ok: false; error: string }

/** etapas que saem do painel principal (aba Histórico) */
const CLOSED: ExportStatus[] = ['FINISHED', 'CANCELLED']
const SHORT_MAX = 120
const LONG_MAX = 2000
const PLACE_MAX = 300
const PLACE_FIELDS = ['originPlace', 'destinationPlace'] as const
/** todos os campos aceitos num patch (erro de compilação se TrackingValues não cobrir TRACKING_FIELDS) */
const PATCH_FIELDS: readonly PatchField[] = [...TRACKING_FIELDS, ...PLACE_FIELDS]

class PatchError extends Error {}

const asText = (v: TrackingValue | undefined) => (v == null || v === '' ? null : String(v))
const sameValue = (a: TrackingValue | undefined, b: TrackingValue | undefined) => asText(a) === asText(b)

// ---------------------------------------------------------------------------
// Validação do patch (antes de tocar no banco)
// ---------------------------------------------------------------------------

function normalizePatch(patch: TrackingPatch, api: boolean): Map<PatchField, TrackingValue> {
  if (!patch || typeof patch !== 'object') throw new PatchError('Alteração inválida.')
  const raw = patch as Record<string, unknown>
  const out = new Map<PatchField, TrackingValue>()
  const text = (f: PatchField, v: unknown, max: number) => {
    if (v == null) return null
    if (typeof v !== 'string' && typeof v !== 'number') throw new PatchError(`${FIELD_LABEL[f]}: valor inválido.`)
    const t = String(v).trim()
    if (!t) return null
    if (t.length <= max) return t
    if (api) return t.slice(0, max)
    throw new PatchError(`${FIELD_LABEL[f]}: máximo de ${max} caracteres.`)
  }
  for (const f of PATCH_FIELDS) {
    if (!(f in raw) || raw[f] === undefined) continue
    const v = raw[f]
    const label = FIELD_LABEL[f]
    if (f === 'status') {
      if (!isExportStatus(v)) throw new PatchError('Status inválido.')
      out.set(f, v)
    } else if (f === 'delayed') {
      if (typeof v !== 'boolean') throw new PatchError(`${label}: valor inválido.`)
      out.set(f, v)
    } else if (DATE_FIELDS.includes(f as TrackingField)) {
      if (v == null || v === '') {
        if (f === 'confirmedAt') throw new PatchError('A data de confirmação do pedido é obrigatória.')
        out.set(f, null)
      } else if (!isIsoDate(v)) throw new PatchError(`${label}: data inválida.`)
      else out.set(f, v)
    } else if (f === 'transitDays') {
      if (v == null || v === '') out.set(f, null)
      else {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
        if (!Number.isInteger(n) || n < 0 || n > 365) throw new PatchError(`${label}: informe um número inteiro de 0 a 365.`)
        out.set(f, n)
      }
    } else if (f === 'responsibleUserId') {
      if (v == null || v === '') out.set(f, null)
      else {
        const n = Number(v)
        if (!Number.isInteger(n) || n <= 0) throw new PatchError('Responsável inválido.')
        out.set(f, n)
      }
    } else if (f === 'originPlace' || f === 'destinationPlace') {
      // mesmo formato de src/lib/places.ts (placeValue): espaços normalizados, vazio = null
      const t = text(f, typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, api ? Number.MAX_SAFE_INTEGER : PLACE_MAX)
      out.set(f, t ? t.slice(0, PLACE_MAX) : null)
    } else if (f === 'containerNumber') {
      // maiúsculas e sem espaços; NÃO recusa fora do ISO 6346 (caminhões usam placa) — a tela avisa
      const t = text(f, typeof v === 'string' ? v.replace(/\s+/g, '') : v, SHORT_MAX)
      out.set(f, t ? t.toUpperCase() : null)
    } else out.set(f, text(f, v, f === 'notes' || f === 'incident' ? LONG_MAX : SHORT_MAX))
  }
  return out
}

/** usuários ativos que podem editar o seguimento (select "Responsável"), por nome */
export async function trackingEditors(): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, areas: schema.users.areas })
    .from(schema.users)
    .where(eq(schema.users.active, true))
    .orderBy(asc(schema.users.name))
  return rows.filter((u) => canEditExports(u)).map((u) => ({ id: u.id, name: u.name }))
}

// ---------------------------------------------------------------------------
// ESCRITA: o único caminho (tela e integrações)
// ---------------------------------------------------------------------------

/**
 * Aplica um patch a uma ou mais operações (a primeira é a ORIGINAL; as demais, outras cargas do mesmo
 * pedido — nelas os campos por unidade, contêiner e lacre, são ignorados). Por operação: só os campos que
 * mudam; ETA = ETD + trânsito sempre que os dois existem (origem CALC, sobrepõe a ETA enviada); status
 * FINISHED/CANCELLED fecha (closedAt) e voltar a uma etapa ativa reabre; fieldSources, updatedAt/By e um
 * evento por mudança no histórico. Origem/destino vão para o PEDIDO (uma vez por pedido) e ficam no
 * histórico de todas as operações dele. Tudo numa transação: um erro não grava nada.
 */
export async function applyTrackingPatch(opIds: number[], patch: TrackingPatch, actor: TrackingActor): Promise<PatchResult> {
  const ids = [...new Set(opIds)].filter((x) => Number.isInteger(x) && x > 0)
  if (!ids.length) return { ok: false, error: 'Operação não encontrada.' }
  const api = actor.source === 'API'
  let values: Map<PatchField, TrackingValue>
  try {
    values = normalizePatch(patch, api)
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message }
    throw e
  }
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const provider = api ? actor.provider?.trim().slice(0, SHORT_MAX) || null : null
  const ref = api && actor.ref !== undefined ? actor.ref?.trim().slice(0, SHORT_MAX) || null : undefined
  const src: FieldSource = { source: actor.source, at: now, ...(actor.userId != null ? { by: actor.userId } : {}), ...(provider ? { provider } : {}) }
  const calcSrc: FieldSource = { source: 'CALC', at: now }
  const needNames = values.has('responsibleUserId')
  const eligible = needNames ? new Set((await trackingEditors()).map((u) => u.id)) : new Set<number>()
  const names = needNames ? new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((u) => [u.id, u.name])) : new Map<number, string>()
  const uname = (id: number) => names.get(id) ?? `#${id}`

  try {
    return await db.transaction(async (tx) => {
      const ops = await tx.select().from(schema.exportOperations).where(inArray(schema.exportOperations.id, ids)).for('update')
      if (ops.length !== ids.length) throw new PatchError('Operação não encontrada.')
      const byId = new Map(ops.map((o) => [o.id, o]))

      // origem/destino: no pedido (uma vez por pedido); o histórico vai para todas as operações dele
      const placeChanges = new Map<number, { field: (typeof PLACE_FIELDS)[number]; before: string | null; after: string | null }[]>()
      const targets = [...ids]
      if (PLACE_FIELDS.some((f) => values.has(f))) {
        const plans = await tx.select({ id: schema.loadPlans.id, shipmentId: schema.loadPlans.shipmentId }).from(schema.loadPlans).where(inArray(schema.loadPlans.id, ops.map((o) => o.loadPlanId)))
        const shipIds = [...new Set(plans.map((p) => p.shipmentId))]
        const ships = await tx
          .select({ id: schema.shipments.id, originPlace: schema.shipments.originPlace, destinationPlace: schema.shipments.destinationPlace })
          .from(schema.shipments)
          .where(inArray(schema.shipments.id, shipIds))
          .for('update')
        const changedShips: { id: number; changes: { field: (typeof PLACE_FIELDS)[number]; before: string | null; after: string | null }[] }[] = []
        for (const sh of ships) {
          const changes = PLACE_FIELDS.filter((f) => values.has(f) && !sameValue(sh[f], values.get(f))).map((f) => ({ field: f, before: sh[f], after: (values.get(f) as string | null) ?? null }))
          if (!changes.length) continue
          const set: Partial<typeof schema.shipments.$inferInsert> = { updatedAt: nowDate, ...(actor.userId != null ? { updatedBy: actor.userId } : {}) }
          for (const c of changes) set[c.field] = c.after
          await tx.update(schema.shipments).set(set).where(eq(schema.shipments.id, sh.id))
          changedShips.push({ id: sh.id, changes })
        }
        if (changedShips.length) {
          const shipPlans = await tx.select({ id: schema.loadPlans.id, shipmentId: schema.loadPlans.shipmentId }).from(schema.loadPlans).where(inArray(schema.loadPlans.shipmentId, changedShips.map((s) => s.id)))
          const shipOf = new Map(shipPlans.map((p) => [p.id, p.shipmentId]))
          const shipOps = await tx.select().from(schema.exportOperations).where(inArray(schema.exportOperations.loadPlanId, shipPlans.map((p) => p.id))).for('update')
          for (const o of shipOps) {
            byId.set(o.id, byId.get(o.id) ?? o)
            if (!targets.includes(o.id)) targets.push(o.id)
            placeChanges.set(o.id, changedShips.find((s) => s.id === shipOf.get(o.loadPlanId))?.changes ?? [])
          }
        }
      }

      const events: EventInsert[] = []
      const updated: number[] = []
      const ev = (op: OpRow, kind: ExportEventKind, source: ExportEventSource, field: string, before: TrackingValue | undefined, after: TrackingValue | undefined, message: string): EventInsert => ({
        operationId: op.id,
        at: nowDate,
        userId: actor.userId,
        source,
        kind,
        field,
        oldValue: asText(before),
        newValue: asText(after),
        message,
      })

      for (const [i, id] of targets.entries()) {
        const op = byId.get(id)!
        const patched = ids.includes(id)
        const next: Record<string, unknown> = {}
        const sources: FieldSources = { ...(op.fieldSources ?? {}) }
        const opEvents: EventInsert[] = []
        const cur = (f: TrackingField) => op[f] as TrackingValue
        // ETA calculada quando ETD e trânsito (após o patch) existem: a ETA enviada é ignorada
        const etdN = patched && values.has('etd') ? (values.get('etd') as string | null) : op.etd
        const tdN = patched && values.has('transitDays') ? (values.get('transitDays') as number | null) : op.transitDays
        const calc = etaFrom(etdN, tdN)

        if (patched) {
          for (const [f, v] of values) {
            if (f === 'originPlace' || f === 'destinationPlace') continue
            // contêiner e lacre: só na carga original (cada unidade tem o seu)
            if (i > 0 && PER_UNIT_FIELDS.includes(f)) continue
            if (f === 'eta' && calc) continue
            const before = cur(f)
            if (sameValue(before, v)) continue
            if (f === 'responsibleUserId' && v != null && !eligible.has(v as number)) throw new PatchError('Responsável inválido: escolha um usuário ativo da Exportação que edite o seguimento.')
            next[f] = v
            sources[f] = src
            opEvents.push(ev(op, f === 'status' ? 'status' : 'field', actor.source, f, before, v, describeChange(f, before, v, uname)))
          }
          if (calc && !sameValue(op.eta, calc)) {
            next.eta = calc
            sources.eta = calcSrc
            opEvents.push(ev(op, 'field', 'CALC', 'eta', op.eta, calc, `${describeChange('eta', op.eta, calc)} (calculada)`))
          } else if (calc && sources.eta?.source !== 'CALC' && opEvents.length) sources.eta = calcSrc
        }
        for (const c of placeChanges.get(id) ?? []) {
          sources[c.field] = src
          opEvents.push(ev(op, 'field', actor.source, c.field, c.before, c.after, describeChange(c.field, c.before, c.after)))
        }

        // etapa final (Finalizado/Cancelado) sai do painel; voltar a uma etapa ativa reabre
        if ('status' in next) {
          const s = next.status as ExportStatus
          if (!isActiveStatus(s) && !op.closedAt) next.closedAt = nowDate
          if (isActiveStatus(s) && op.closedAt) next.closedAt = null
        }
        if ('currentLocation' in next || 'trackingStatus' in next) next.lastTrackingUpdate = nowDate
        if (api && patched) {
          next.lastTrackingUpdate = nowDate
          if (provider && provider !== op.trackingProvider) next.trackingProvider = provider
          if (ref !== undefined && ref !== op.trackingRef) next.trackingRef = ref
        }
        if (opEvents.length) {
          next.fieldSources = sources
          next.updatedAt = nowDate
          next.updatedBy = actor.userId
          events.push(...opEvents)
          updated.push(id)
        }
        if (Object.keys(next).length) await tx.update(schema.exportOperations).set(next as Partial<typeof schema.exportOperations.$inferInsert>).where(eq(schema.exportOperations.id, id))
      }
      if (events.length) await tx.insert(schema.exportEvents).values(events)
      return { ok: true as const, updated, events: events.length }
    })
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * Confirma o pedido: cria a operação de seguimento de cada carga. planIds[0] é a carga confirmada (precisa
 * ser da Exportação, ter versão APROVADA e ainda não ter operação → senão erro). Os demais ids — e, com
 * includeSiblings, as outras unidades do mesmo pedido — entram só se forem do mesmo pedido, tiverem versão
 * aprovada e não tiverem operação (as outras são ignoradas). created = ids das operações (created[0] = da
 * carga principal); planIds = cargas confirmadas, na mesma ordem.
 */
export async function confirmOrder(
  planIds: number[],
  input: ConfirmInput,
  me: AreaUser & { id: number },
): Promise<{ ok: true; created: number[]; planIds: number[] } | { ok: false; error: string }> {
  if (!canConfirmExports(me)) return { ok: false, error: 'Você não tem permissão para confirmar pedidos de exportação.' }
  const main = planIds[0]
  if (!Number.isInteger(main)) return { ok: false, error: 'Carga não encontrada.' }
  const confirmedAt = input?.confirmedAt ? String(input.confirmedAt) : todayBR()
  if (!isIsoDate(confirmedAt)) return { ok: false, error: 'Data de confirmação inválida.' }
  const paymentReceivedAt = input?.paymentReceivedAt ? String(input.paymentReceivedAt) : null
  if (paymentReceivedAt && !isIsoDate(paymentReceivedAt)) return { ok: false, error: 'Data de recebimento do pagamento inválida.' }

  const [p] = await db
    .select({ id: schema.loadPlans.id, shipmentId: schema.loadPlans.shipmentId, area: schema.shipments.area })
    .from(schema.loadPlans)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(eq(schema.loadPlans.id, main))
    .limit(1)
  if (!p) return { ok: false, error: 'Carga não encontrada.' }
  if (p.area !== 'EXPORT') return { ok: false, error: 'Só cargas da Exportação têm seguimento de exportação.' }
  const units = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, p.shipmentId)).orderBy(asc(schema.loadPlans.id))
  const sameOrder = new Set(units.map((u) => u.id))
  const wanted = [main, ...planIds.slice(1), ...(input?.includeSiblings ? units.map((u) => u.id) : [])]
  const candidates = [...new Set(wanted)].filter((id) => sameOrder.has(id))
  const approved = new Map<number, number>()
  for (const v of await db
    .select({ id: schema.loadPlanVersions.id, loadPlanId: schema.loadPlanVersions.loadPlanId })
    .from(schema.loadPlanVersions)
    .where(and(inArray(schema.loadPlanVersions.loadPlanId, candidates), eq(schema.loadPlanVersions.status, 'APPROVED')))
    .orderBy(desc(schema.loadPlanVersions.version)))
    if (!approved.has(v.loadPlanId)) approved.set(v.loadPlanId, v.id)
  const existing = new Set((await db.select({ loadPlanId: schema.exportOperations.loadPlanId }).from(schema.exportOperations).where(inArray(schema.exportOperations.loadPlanId, candidates))).map((o) => o.loadPlanId))
  if (!approved.has(main)) return { ok: false, error: 'A carga precisa ter uma versão aprovada para confirmar o pedido.' }
  if (existing.has(main)) return { ok: false, error: 'O pedido desta carga já foi confirmado.' }
  const toCreate = candidates.filter((id) => approved.has(id) && !existing.has(id))

  const nowDate = new Date()
  const src: FieldSource = { source: 'MANUAL', at: nowDate.toISOString(), by: me.id }
  try {
    return await db.transaction(async (tx) => {
      // trava as cargas (em ordem de id) e confere DE NOVO a versão aprovada: "Desfazer aprovação" trava
      // a mesma linha, então ou já terminou (e a versão pode ter voltado a rascunho) ou espera esta
      // confirmação (e vê a operação). Nunca operação apontando para uma versão que deixou de ser aprovada.
      await tx.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(inArray(schema.loadPlans.id, toCreate)).orderBy(asc(schema.loadPlans.id)).for('no key update')
      const approvedNow = new Map<number, number>()
      for (const v of await tx
        .select({ id: schema.loadPlanVersions.id, loadPlanId: schema.loadPlanVersions.loadPlanId })
        .from(schema.loadPlanVersions)
        .where(and(inArray(schema.loadPlanVersions.loadPlanId, toCreate), eq(schema.loadPlanVersions.status, 'APPROVED')))
        .orderBy(desc(schema.loadPlanVersions.version)))
        if (!approvedNow.has(v.loadPlanId)) approvedNow.set(v.loadPlanId, v.id)
      const created: number[] = []
      const confirmed: number[] = []
      const events: EventInsert[] = []
      for (const planId of toCreate) {
        // aprovação desfeita no meio tempo
        if (!approvedNow.has(planId)) {
          if (planId === main) throw new PatchError('A carga precisa ter uma versão aprovada para confirmar o pedido.')
          continue
        }
        const [row] = await tx
          .insert(schema.exportOperations)
          .values({
            loadPlanId: planId,
            confirmedVersionId: approvedNow.get(planId)!,
            status: 'CONFIRMED',
            confirmedAt,
            confirmedBy: me.id,
            // responsável inicial = quem confirmou (troca-se no seguimento)
            responsibleUserId: me.id,
            paymentReceivedAt,
            fieldSources: { confirmedAt: src, responsibleUserId: src, ...(paymentReceivedAt ? { paymentReceivedAt: src } : {}) },
            createdBy: me.id,
            updatedBy: me.id,
          })
          .onConflictDoNothing({ target: schema.exportOperations.loadPlanId })
          .returning({ id: schema.exportOperations.id })
        // outra pessoa confirmou ao mesmo tempo
        if (!row) {
          if (planId === main) throw new PatchError('O pedido desta carga já foi confirmado.')
          continue
        }
        created.push(row.id)
        confirmed.push(planId)
        events.push({ operationId: row.id, at: nowDate, userId: me.id, source: 'MANUAL', kind: 'confirm', field: 'confirmedAt', oldValue: null, newValue: confirmedAt, message: 'Pedido confirmado' })
        if (paymentReceivedAt)
          events.push({ operationId: row.id, at: nowDate, userId: me.id, source: 'MANUAL', kind: 'field', field: 'paymentReceivedAt', oldValue: null, newValue: paymentReceivedAt, message: describeChange('paymentReceivedAt', null, paymentReceivedAt) })
      }
      if (events.length) await tx.insert(schema.exportEvents).values(events)
      return { ok: true as const, created, planIds: confirmed }
    })
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * Desfaz a confirmação: só enquanto o status é CONFIRMED. Exclui a operação (o histórico vai junto, em
 * cascata). Devolve a operação excluída (para a auditoria) e a carga, para onde a tela deve voltar.
 */
export async function undoConfirmation(opId: number, me: AreaUser & { id: number }): Promise<{ ok: true; loadPlanId: number; removed: OpRow } | { ok: false; error: string }> {
  if (!canEditExports(me)) return { ok: false, error: 'Você não tem permissão para desfazer a confirmação.' }
  if (!Number.isInteger(opId)) return { ok: false, error: 'Operação não encontrada.' }
  try {
    return await db.transaction(async (tx) => {
      const [op] = await tx.select().from(schema.exportOperations).where(eq(schema.exportOperations.id, opId)).for('update')
      if (!op) throw new PatchError('Operação não encontrada.')
      if (op.status !== 'CONFIRMED') throw new PatchError('Só é possível desfazer a confirmação enquanto o status é “Pedido confirmado”.')
      await tx.delete(schema.exportOperations).where(eq(schema.exportOperations.id, opId))
      return { ok: true as const, loadPlanId: op.loadPlanId, removed: op }
    })
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message }
    throw e
  }
}

// ---------------------------------------------------------------------------
// LEITURA
// ---------------------------------------------------------------------------

/** operação de cada carga (página da carga, painel de cargas): Map<loadPlanId, {id, status}> */
export async function operationIdsByPlan(planIds: number[]): Promise<Map<number, { id: number; status: ExportStatus }>> {
  const ids = [...new Set(planIds)].filter((x) => Number.isInteger(x))
  if (!ids.length) return new Map()
  const rows = await db
    .select({ id: schema.exportOperations.id, loadPlanId: schema.exportOperations.loadPlanId, status: schema.exportOperations.status })
    .from(schema.exportOperations)
    .where(inArray(schema.exportOperations.loadPlanId, ids))
  return new Map(rows.map((r) => [r.loadPlanId, { id: r.id, status: r.status }]))
}

/**
 * Operação + as outras operações do mesmo pedido, com o status de cada uma (para as actions: permissão,
 * "aplicar às outras cargas do pedido" — só as em curso — e revalidação). null se não existir.
 */
export async function operationContext(opId: number): Promise<{ id: number; loadPlanId: number; shipmentId: number; status: ExportStatus; planIds: number[]; siblings: { id: number; loadPlanId: number; status: ExportStatus }[] } | null> {
  if (!Number.isInteger(opId)) return null
  const [op] = await db
    .select({ id: schema.exportOperations.id, loadPlanId: schema.exportOperations.loadPlanId, status: schema.exportOperations.status, shipmentId: schema.loadPlans.shipmentId })
    .from(schema.exportOperations)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.exportOperations.loadPlanId))
    .where(eq(schema.exportOperations.id, opId))
    .limit(1)
  if (!op) return null
  const plans = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, op.shipmentId)).orderBy(asc(schema.loadPlans.id))
  const ops = await db
    .select({ id: schema.exportOperations.id, loadPlanId: schema.exportOperations.loadPlanId, status: schema.exportOperations.status })
    .from(schema.exportOperations)
    .where(inArray(schema.exportOperations.loadPlanId, plans.map((p) => p.id)))
  return { ...op, planIds: plans.map((p) => p.id), siblings: ops.filter((o) => o.id !== op.id).sort((a, b) => a.loadPlanId - b.loadPlanId) }
}

/** Botão/diálogo "Confirmar pedido" × "Ver seguimento" na página da carga. null = não se aplica (área/papel). */
export async function confirmContext(planId: number, u: AreaUser): Promise<ConfirmContext | null> {
  if (!canSeeExports(u) || !Number.isInteger(planId)) return null
  const [p] = await db
    .select({ shipmentId: schema.loadPlans.shipmentId, area: schema.shipments.area })
    .from(schema.loadPlans)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(eq(schema.loadPlans.id, planId))
    .limit(1)
  if (!p || p.area !== 'EXPORT') return null
  const units = await db.select({ id: schema.loadPlans.id, name: schema.loadPlans.name }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, p.shipmentId)).orderBy(asc(schema.loadPlans.id))
  const ids = units.map((x) => x.id)
  const approved = new Set(
    (await db.selectDistinct({ id: schema.loadPlanVersions.loadPlanId }).from(schema.loadPlanVersions).where(and(inArray(schema.loadPlanVersions.loadPlanId, ids), eq(schema.loadPlanVersions.status, 'APPROVED')))).map((x) => x.id),
  )
  const ops = await operationIdsByPlan(ids)
  const own = ops.get(planId)
  return {
    operationId: own?.id ?? null,
    status: own?.status ?? null,
    hasApproved: approved.has(planId),
    canConfirm: !own && approved.has(planId) && canConfirmExports(u),
    siblingsToConfirm: units.flatMap((x, i) => (x.id !== planId && approved.has(x.id) && !ops.has(x.id) ? [{ loadPlanId: x.id, planName: x.name, unitIndex: i + 1 }] : [])),
  }
}

interface RowCtx {
  users: Map<number, { name: string; avatar: AvatarRef }>
  units: Map<number, number[]>
  companies: Map<number, string>
  /** condição de pagamento (dado comercial): só para quem vê preços */
  viewPrices: boolean
}

function toRow(
  op: OpRow,
  plan: { id: number; name: string; shipmentId: number; createdBy: number | null; transportCompanyId: number | null; paymentTerms: PaymentTerms | null },
  shipment: typeof schema.shipments.$inferSelect,
  customer: string,
  equipment: string | null,
  ctx: RowCtx,
): ExportRow {
  const units = ctx.units.get(plan.shipmentId) ?? [plan.id]
  const user = (id: number | null) => (id != null ? ctx.users.get(id) ?? null : null)
  return {
    id: op.id,
    loadPlanId: plan.id,
    shipmentId: plan.shipmentId,
    planName: plan.name,
    unitIndex: units.length > 1 ? units.indexOf(plan.id) + 1 : null,
    unitCount: units.length,
    customer,
    country: shipment.destinationCountry,
    orderRef: shipment.orderRef ? orderRefLabel(shipment.orderRef, shipment.area) : null,
    incoterm: shipment.incoterm,
    service: serviceOf(shipment),
    mode: shipment.mode,
    equipment,
    transportCompany: plan.transportCompanyId != null ? ctx.companies.get(plan.transportCompanyId) ?? null : null,
    cfop: shipment.cfop ?? null,
    paymentTerms: ctx.viewPrices ? paymentTermsText(plan.paymentTerms, 'pt') : null,
    status: op.status,
    delayed: op.delayed,
    incident: op.incident,
    confirmedAt: op.confirmedAt,
    paymentReceivedAt: op.paymentReceivedAt,
    plannedLoadingDate: op.plannedLoadingDate,
    actualLoadingDate: op.actualLoadingDate,
    etd: op.etd,
    atd: op.atd,
    transitDays: op.transitDays,
    eta: op.eta,
    ata: op.ata,
    deliveredAt: op.deliveredAt,
    carrier: op.carrier,
    forwarder: op.forwarder,
    bookingNumber: op.bookingNumber,
    containerNumber: op.containerNumber,
    sealNumber: op.sealNumber,
    blNumber: op.blNumber,
    vessel: op.vessel,
    voyage: op.voyage,
    originPlace: shipment.originPlace,
    destinationPlace: shipment.destinationPlace,
    responsibleUserId: op.responsibleUserId,
    responsibleName: user(op.responsibleUserId)?.name ?? null,
    responsibleAvatar: user(op.responsibleUserId)?.avatar ?? null,
    loadCreatedByName: user(plan.createdBy)?.name ?? null,
    updatedAt: op.updatedAt.toISOString(),
    updatedByName: user(op.updatedBy)?.name ?? null,
    closedAt: op.closedAt?.toISOString() ?? null,
  }
}

async function userMap() {
  const rows = await db.select({ id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar }).from(schema.users)
  return new Map(rows.map((x) => [x.id, { name: x.name, avatar: avatarRef(x.id, x.avatar) }]))
}

async function unitsOf(shipIds: number[]) {
  const m = new Map<number, number[]>()
  if (!shipIds.length) return m
  const rows = await db.select({ id: schema.loadPlans.id, shipmentId: schema.loadPlans.shipmentId }).from(schema.loadPlans).where(inArray(schema.loadPlans.shipmentId, shipIds)).orderBy(asc(schema.loadPlans.id))
  for (const r of rows) m.set(r.shipmentId, [...(m.get(r.shipmentId) ?? []), r.id])
  return m
}

async function companyMap(ids: number[]) {
  if (!ids.length) return new Map<number, string>()
  const rows = await db.select({ id: schema.transportCompanies.id, code: schema.transportCompanies.code, name: schema.transportCompanies.name }).from(schema.transportCompanies).where(inArray(schema.transportCompanies.id, ids))
  return new Map(rows.map((c) => [c.id, transportCompanyLabel(c)]))
}

/**
 * Lista do módulo: 'active' = em curso (painel principal), 'history' = Finalizadas e Canceladas.
 * Só cargas da Exportação; vazio para quem não vê o módulo. Equipamento = da última versão aprovada.
 * Ordem: em curso por confirmação (mais recente primeiro); histórico por fechamento (mais recente primeiro).
 */
export async function trackingRows(u: AreaUser, scope: 'active' | 'history'): Promise<ExportRow[]> {
  if (!canSeeExports(u)) return []
  const rows = await db
    .select({
      op: schema.exportOperations,
      plan: {
        id: schema.loadPlans.id,
        name: schema.loadPlans.name,
        shipmentId: schema.loadPlans.shipmentId,
        createdBy: schema.loadPlans.createdBy,
        transportCompanyId: schema.loadPlans.transportCompanyId,
        paymentTerms: schema.loadPlans.paymentTerms,
      },
      shipment: schema.shipments,
      customer: schema.customers.name,
    })
    .from(schema.exportOperations)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.exportOperations.loadPlanId))
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.shipments.customerId))
    .where(and(eq(schema.shipments.area, 'EXPORT'), scope === 'active' ? notInArray(schema.exportOperations.status, CLOSED) : inArray(schema.exportOperations.status, CLOSED)))
  if (!rows.length) return []
  const planIds = rows.map((r) => r.plan.id)
  // equipamento da última versão APROVADA, sem carregar o documento inteiro
  const equipment = new Map<number, string>()
  for (const v of await db
    .select({ loadPlanId: schema.loadPlanVersions.loadPlanId, code: sql<string>`${schema.loadPlanVersions.document}->'space'->>'code'` })
    .from(schema.loadPlanVersions)
    .where(and(inArray(schema.loadPlanVersions.loadPlanId, planIds), eq(schema.loadPlanVersions.status, 'APPROVED')))
    .orderBy(desc(schema.loadPlanVersions.version)))
    if (!equipment.has(v.loadPlanId)) equipment.set(v.loadPlanId, v.code)
  const [users, units, companies] = await Promise.all([
    userMap(),
    unitsOf([...new Set(rows.map((r) => r.plan.shipmentId))]),
    companyMap([...new Set(rows.map((r) => r.plan.transportCompanyId).filter((x): x is number => x != null))]),
  ])
  const ctx: RowCtx = { users, units, companies, viewPrices: can.viewPrices(u.role) }
  const out = rows.map((r) => toRow(r.op, r.plan, r.shipment, r.customer, equipment.get(r.plan.id) ?? null, ctx))
  return scope === 'active' ? out.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt) || b.id - a.id) : out.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.id - a.id)
}

/**
 * Detalhe de uma operação (/exportacoes/[id]); null se não existir ou se o usuário não puder ver.
 * Produtos, totais e equipamento vêm da última versão APROVADA; valor (USD) só para quem vê preços.
 */
export async function trackingDetail(id: number, u: AreaUser): Promise<ExportDetail | null> {
  if (!canSeeExports(u) || !Number.isInteger(id)) return null
  const op = await db.query.exportOperations.findFirst({ where: eq(schema.exportOperations.id, id) })
  if (!op) return null
  const data = await loadPlanVersion(op.loadPlanId, undefined, { approvedOnly: true })
  const plan = data?.plan ?? (await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, op.loadPlanId) }))
  if (!plan) return null
  const shipment = data?.shipment ?? (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) }))
  if (!shipment || shipment.area !== 'EXPORT') return null
  const customer = data?.customer ?? (await db.query.customers.findFirst({ where: eq(schema.customers.id, shipment.customerId) }))
  const v = data?.v ?? null

  const [users, units, companies, editors] = await Promise.all([userMap(), unitsOf([plan.shipmentId]), companyMap(plan.transportCompanyId != null ? [plan.transportCompanyId] : []), trackingEditors()])
  const row = toRow(op, plan, shipment, customer?.name ?? '—', v?.document.space.code ?? null, { users, units, companies, viewPrices: can.viewPrices(u.role) })
  const uname = (uid: number | null) => (uid != null ? users.get(uid)?.name ?? null : null)

  // outras unidades do pedido
  const unitIds = units.get(plan.shipmentId) ?? [plan.id]
  const unitRows = await db.select({ id: schema.loadPlans.id, name: schema.loadPlans.name }).from(schema.loadPlans).where(inArray(schema.loadPlans.id, unitIds))
  const approvedPlans = new Set(
    (await db.selectDistinct({ id: schema.loadPlanVersions.loadPlanId }).from(schema.loadPlanVersions).where(and(inArray(schema.loadPlanVersions.loadPlanId, unitIds), eq(schema.loadPlanVersions.status, 'APPROVED')))).map((x) => x.id),
  )
  const unitOps = new Map((await db.select({ id: schema.exportOperations.id, loadPlanId: schema.exportOperations.loadPlanId, status: schema.exportOperations.status }).from(schema.exportOperations).where(inArray(schema.exportOperations.loadPlanId, unitIds))).map((o) => [o.loadPlanId, o]))
  const siblings: ExportSibling[] = unitIds.flatMap((pid, i) => {
    if (pid === plan.id) return []
    const o = unitOps.get(pid)
    return [{ loadPlanId: pid, planName: unitRows.find((x) => x.id === pid)?.name ?? `#${pid}`, unitIndex: i + 1, operationId: o?.id ?? null, status: o?.status ?? null, hasApproved: approvedPlans.has(pid) }]
  })

  // produtos e totais da versão aprovada
  let products: ExportProduct[] = []
  let totals: ExportDetail['totals'] = null
  if (v) {
    const acc = new Map<string, ExportProduct>()
    for (const g of loadGeometries(v.document))
      for (const l of g.bySku) {
        const p = acc.get(l.sku) ?? { sku: l.sku, name: l.name, boxes: 0, units: 0, netKg: 0, grossKg: 0 }
        p.boxes += l.packages
        p.units += l.units
        p.netKg += l.netKg
        p.grossKg += l.grossKg
        acc.set(l.sku, p)
      }
    const r3 = (n: number) => Math.round(n * 1000) / 1000
    products = [...acc.values()].map((p) => ({ ...p, netKg: r3(p.netKg), grossKg: r3(p.grossKg) })).sort((a, b) => a.sku.localeCompare(b.sku, 'pt-BR', { numeric: true }))
    const s = v.summary ?? loadSummary(v.document)
    totals = { pallets: s.pallets, packages: s.packages, units: s.units, netKg: s.netKg, payloadKg: s.payloadKg, grossKg: s.grossKg, cbm: s.cbmUnits }
  }
  let value: ExportDetail['value'] = null
  if (v && can.viewPrices(u.role)) {
    const pv = await planValue({ v, shipment, plan })
    value = { ...proformaTotals(pv.value.totals.USD ?? null, plan.freightUsd, plan.insuranceUsd), source: pv.source }
  }
  const confirmedVersion =
    op.confirmedVersionId == null ? null : op.confirmedVersionId === v?.id ? v.version : ((await db.select({ version: schema.loadPlanVersions.version }).from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.id, op.confirmedVersionId)).limit(1))[0]?.version ?? null)
  const agent = plan.agentId != null ? await db.query.agents.findFirst({ where: eq(schema.agents.id, plan.agentId) }) : null
  const events: ExportEvent[] = (
    await db.select().from(schema.exportEvents).where(eq(schema.exportEvents.operationId, op.id)).orderBy(desc(schema.exportEvents.at), desc(schema.exportEvents.id))
  ).map((e) => ({ id: e.id, at: e.at.toISOString(), userName: uname(e.userId), source: e.source as ExportEventSource, kind: e.kind as ExportEventKind, field: e.field, message: e.message }))
  const canEdit = canEditExports(u)

  return {
    ...row,
    fieldSources: op.fieldSources ?? {},
    notes: op.notes,
    currentLocation: op.currentLocation,
    trackingStatus: op.trackingStatus,
    lastTrackingUpdate: op.lastTrackingUpdate?.toISOString() ?? null,
    trackingProvider: op.trackingProvider,
    trackingRef: op.trackingRef,
    equipment: v ? { code: v.document.space.code, name: v.document.space.name } : null,
    agentName: agent?.name ?? null,
    approvedVersion: v ? { id: v.id, version: v.version, approvedAt: v.approvedAt?.toISOString() ?? null, approvedByName: uname(v.approvedBy) } : null,
    confirmedVersionId: op.confirmedVersionId,
    confirmedVersion,
    newerApprovedThanConfirmed: v != null && op.confirmedVersionId != null && v.id !== op.confirmedVersionId,
    products,
    totals,
    value,
    siblings,
    events,
    users: editors,
    canEdit,
    canUndo: canEdit && op.status === 'CONFIRMED',
  }
}

// ---------------------------------------------------------------------------
// RESUMO PARA O CLIENTE (PDF "Status do embarque")
// ---------------------------------------------------------------------------

/**
 * Produtos como na Proforma (ordem do catálogo, nome da versão, caixas de kits, bruto com a parte da tara dos
 * paletes), totais (bruto = com paletes) e equipamento de uma versão — o mesmo cálculo de src/lib/pdf/orderData.ts.
 */
function summaryVersion(doc: LoadDoc, rank: Map<string, number>): SummaryVersionInput {
  const geoms = loadGeometries(doc)
  const s = loadSummary(doc, geoms)
  const tare = palletTareBySku(doc)
  const kitPacks = new Map<string, PackSnapshot[]>()
  for (const g of geoms) {
    const u = g.unit
    const pd = u.kind === 'PALLET' ? doc.pallets[u.palletKey] : undefined
    const list = u.kind === 'PALLET' ? (pd ? pd.items.map((it) => pd.packs[it.packId]) : []) : [doc.packs[u.packId]]
    for (const k of list) if (k && kitFamilyOf(k.sku)) kitPacks.set(k.sku, [...(kitPacks.get(k.sku) ?? []), k])
  }
  const last = Number.MAX_SAFE_INTEGER
  return {
    equipment: { code: doc.space.code, name: doc.space.name, service: doc.space.kind === 'NONE' ? (doc.space.service ?? 'PALLETS_ONLY') : null },
    products: [...s.bySku]
      .sort((a, b) => (rank.get(a.sku.toUpperCase()) ?? last) - (rank.get(b.sku.toUpperCase()) ?? last) || a.sku.localeCompare(b.sku))
      .map((l) => {
        const kits = kitPacks.get(l.sku)
        return { sku: l.sku, name: l.name, kitBoxes: kits?.some((k) => k.kitBox) ? kitBoxLines(kits) : null, boxes: l.packages, units: l.units, netKg: l.netKg, grossKg: l.grossKg + (tare.get(l.sku) ?? 0) }
      }),
    totals: { pallets: s.pallets, packages: s.packages, units: s.units, netKg: s.netKg, grossKg: s.payloadKg },
  }
}

/**
 * Dados do RESUMO PARA O CLIENTE de uma operação (e, com includeSiblings, das outras cargas do pedido que têm
 * seguimento). null = não existe ou o usuário não vê (canSeeExports + área do pedido). Produtos, totais e
 * equipamento da última versão APROVADA de cada carga. O DTO é montado pelo mapper puro trackingSummaryDto
 * (lista de permissões: nada interno — observações, incidência, responsável, pagamento, condição de pagamento,
 * CFOP, transportadora do ERP, valores… — sai daqui).
 */
export async function trackingSummaryData(opId: number, u: AreaUser, o: { includeSiblings: boolean }): Promise<TrackingSummary | null> {
  if (!canSeeExports(u) || !Number.isInteger(opId) || opId <= 0) return null
  const [base] = await db
    .select({ loadPlanId: schema.exportOperations.loadPlanId, shipment: schema.shipments, customer: schema.customers.name })
    .from(schema.exportOperations)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.exportOperations.loadPlanId))
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.shipments.customerId))
    .where(eq(schema.exportOperations.id, opId))
    .limit(1)
  if (!base || base.shipment.area !== 'EXPORT' || !canAccessArea(u, base.shipment.area)) return null
  const unitPlanIds = (await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, base.shipment.id)).orderBy(asc(schema.loadPlans.id))).map((x) => x.id)
  const ops = await db
    .select()
    .from(schema.exportOperations)
    .where(inArray(schema.exportOperations.loadPlanId, o.includeSiblings ? unitPlanIds : [base.loadPlanId]))
  // última versão APROVADA de cada carga: primeiro os ids, depois só os documentos necessários
  const planIds = [...new Set(ops.map((x) => x.loadPlanId))]
  const latest = new Map<number, number>()
  if (planIds.length)
    for (const v of await db
      .select({ id: schema.loadPlanVersions.id, loadPlanId: schema.loadPlanVersions.loadPlanId })
      .from(schema.loadPlanVersions)
      .where(and(inArray(schema.loadPlanVersions.loadPlanId, planIds), eq(schema.loadPlanVersions.status, 'APPROVED')))
      .orderBy(desc(schema.loadPlanVersions.version)))
      if (!latest.has(v.loadPlanId)) latest.set(v.loadPlanId, v.id)
  const docs = latest.size
    ? await db.select({ loadPlanId: schema.loadPlanVersions.loadPlanId, document: schema.loadPlanVersions.document }).from(schema.loadPlanVersions).where(inArray(schema.loadPlanVersions.id, [...latest.values()]))
    : []
  const rank = docs.length ? await productRank() : new Map<string, number>()
  return trackingSummaryDto({
    operationId: opId,
    includeSiblings: o.includeSiblings,
    orderRef: base.shipment.orderRef ? orderRefLabel(base.shipment.orderRef, base.shipment.area) : null,
    customer: base.customer ?? '—',
    shipment: base.shipment,
    unitPlanIds,
    ops,
    versions: new Map(docs.map((d) => [d.loadPlanId, summaryVersion(d.document, rank)])),
  })
}

/**
 * Histórico do resumo para o cliente: 'summary' (PDF gerado) e 'summary_sent' (enviado por e-mail pela
 * plataforma). Registra só nas operações que existem e que o usuário vê (Exportação); as outras são
 * ignoradas. Devolve as operações registradas (para revalidar as páginas).
 */
export async function recordSummaryEvent(opIds: number[], u: AreaUser & { id: number }, kind: 'summary' | 'summary_sent', message: string): Promise<number[]> {
  const ids = [...new Set(opIds)].filter((x) => Number.isInteger(x) && x > 0)
  if (!canSeeExports(u) || !ids.length) return []
  const rows = await db
    .select({ id: schema.exportOperations.id, area: schema.shipments.area })
    .from(schema.exportOperations)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.exportOperations.loadPlanId))
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(inArray(schema.exportOperations.id, ids))
  const visible = rows.filter((r) => r.area === 'EXPORT' && canAccessArea(u, r.area)).map((r) => r.id)
  if (!visible.length) return []
  const at = new Date()
  const text = message.slice(0, LONG_MAX)
  await db.insert(schema.exportEvents).values(visible.map((id): EventInsert => ({ operationId: id, at, userId: u.id, source: 'MANUAL', kind, field: null, oldValue: null, newValue: null, message: text })))
  return visible
}
