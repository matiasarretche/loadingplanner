'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { docOrderLines } from '@/domain/noEquipment'
import { canonicalCountry } from '@/lib/countries'
import { withVehicleLength } from '@/domain/vehicleLength'
import { isNoEquipment, isService, noneSpace, serviceFromMode, ShipmentService, TYPE_INFO, versionSpaceColumns } from '@/domain/shipmentType'
import type { SpaceSnapshot } from '@/domain/types'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db, schema } from '@/db'
import { IntakeDraft, missingForCreate, unitsFor } from '@/domain/intake'
import { resolveLogistics, withRuleLimit } from '@/domain/logisticsRules'
import type { LoadDoc } from '@/domain/types'
import { executeTool, ToolContext } from '@/lib/ai/tools'
import { Area, AREAS, canAccessArea } from '@/lib/areas'
import { assertUser, AuthError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { currentPackCatalog, lockPackagingVersions } from '@/lib/catalog'
import { INCOTERMS } from '@/lib/constants'
import { evaluateDoc, packagingIds } from '@/lib/planEval'
import { containerSpace, limitSnapshot, vehicleSpace } from '@/lib/snapshots'
import { unitNoun } from '@/lib/units'
import { autoPlanName, normalizeOrderRef } from '@/lib/orderRef'
import { placeValue } from '@/lib/places'
import { CUSTOMER_ADDRESS_FIELDS } from '@/domain/customerAddress'
import { checkPaymentTerms } from '@/domain/paymentTerms'
import { cfopError, normalizeCfop } from '@/domain/cfop'
import { resolveTransportCompany } from '@/lib/transportCompanies'

const draftSchema = z.object({
  area: z.string(),
  customerId: z.number().int().positive().nullable(),
  newCustomer: z.string().trim().max(160),
  country: z.string().trim().max(60),
  mode: z.string(),
  incoterm: z.string(),
  equipment: z.string().max(40),
  maxHeightMm: z.number().int().min(300).max(4000).nullable().optional(),
  courierDivisor: z.number().int().min(1000).max(10000).nullable().optional(),
  lengthMm: z.number().int().min(2000).max(25000).nullable().optional(),
  // transportadora do ERP: o id escolhido no seletor (nunca pelo nome — filiais repetem o nome)
  transportCompanyId: z.number().int().positive().nullable().optional(),
  // condição de pagamento (normalizada e validada abaixo) e CFOP do pedido (digitado à mão)
  paymentTerms: z.unknown().optional(),
  cfop: z.string().trim().max(20).nullable().optional(),
  orderRef: z.string().trim().max(80),
  originPlace: z.string().trim().max(300).optional(),
  destinationPlace: z.string().trim().max(300).optional(),
  customerAddress: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(2000),
  lines: z
    .array(z.object({ sku: z.string().max(60).nullable(), quantity: z.number().finite().nullable(), unit: z.enum(['UNIT', 'BOX', 'PALLET', 'KG', 'OTHER']), sourceText: z.string().max(400) }))
    .min(1)
    .max(60),
})

export type IntakeCreateResult = { ok: true; planId: number; units: number; notes: string[] } | { ok: false; error: string; notes?: string[] }

/**
 * Pedido do cliente revisado → envio + carga(s) montada(s) pelo motor (regras logísticas, paletes mistos,
 * divisão em unidades). Grava tudo numa transação; as cargas ficam em RASCUNHO para revisão no editor.
 */
export async function createFromIntakeAction(raw: IntakeDraft): Promise<IntakeCreateResult> {
  try {
    const me = await assertUser('editPlans')
    const p = draftSchema.safeParse(raw)
    if (!p.success) return { ok: false, error: 'Dados inválidos.' }
    const d = p.data as IntakeDraft
    const missing = missingForCreate(d)
    if (missing.length) return { ok: false, error: `Falta completar: ${missing.join(', ')}.` }
    const area = d.area as Area
    if (!AREAS.includes(area) || !canAccessArea(me, area)) return { ok: false, error: 'Área inválida para o seu usuário.' }
    const cc = canonicalCountry(d.country)
    if (!cc) return { ok: false, error: `País "${d.country}" não reconhecido: escolha da lista.` }
    d.country = cc
    if (!INCOTERMS.includes(d.incoterm)) return { ok: false, error: 'Incoterm inválido.' }
    if (!isService(d.mode) && !['SEA', 'ROAD', 'AIR'].includes(d.mode)) return { ok: false, error: 'Tipo de envio inválido.' }
    const service: ShipmentService = isService(d.mode) ? d.mode : serviceFromMode(d.mode)
    const mode = TYPE_INFO[service].mode
    const noEq = isNoEquipment(service)

    // equipamento (mesma validação da tela "Nova carga"); sem equipamento: piso virtual do tipo
    const [kind, idStr] = d.equipment.split(':')
    let space: SpaceSnapshot | undefined
    if (noEq) space = noneSpace(service, { maxHeightMm: d.maxHeightMm ?? undefined, courierDivisor: d.courierDivisor ?? undefined })
    else if (kind === 'CONTAINER' && mode !== 'ROAD') {
      const c = await db.query.containerTypes.findFirst({ where: eq(schema.containerTypes.id, Number(idStr)) })
      space = c && c.active && (c.transportMode === 'AIR') === (mode === 'AIR') ? containerSpace(c) : undefined
    } else if (kind === 'VEHICLE' && mode === 'ROAD') {
      const v = await db.query.vehicleTypes.findFirst({ where: eq(schema.vehicleTypes.id, Number(idStr)) })
      space = v && v.active && v.carrierKind !== 'CHASSIS' ? vehicleSpace(v) : undefined
    }
    if (!space) return { ok: false, error: 'O equipamento não corresponde à modalidade escolhida.' }
    // caminhão: comprimento útil real informado
    if (space.kind === 'VEHICLE' && d.lengthMm) space = withVehicleLength({ space, limits: [], packs: {}, pallets: {}, units: [] }, d.lengthMm).space
    // transportadora (opcional): pelo id, ativa
    const tc = await resolveTransportCompany(d.transportCompanyId ?? null)
    if ('error' in tc) return { ok: false, error: tc.error }
    const transportCompanyId = tc.id
    // condição de pagamento (só Exportação; opcional) e CFOP do pedido (opcional; N.NNN) — gravados como na Nova carga
    const pt = checkPaymentTerms(area === 'EXPORT' ? d.paymentTerms : null)
    if (!pt.ok) return { ok: false, error: pt.error }
    const paymentTerms = pt.terms
    const cfop = normalizeCfop(d.cfop)
    const cfopErr = cfopError(cfop)
    if (cfopErr) return { ok: false, error: cfopErr }

    // quantidades do cliente → unidades de produto (determinístico; paletes completos pelo palete da regra)
    const logistics = mode ? resolveLogistics({ mode, destination: d.country }) : null
    const profiles = (await db.select().from(schema.constraintProfiles).where(eq(schema.constraintProfiles.active, true))).filter((x) => x.scope === 'OPERATIONAL')
    const empty: LoadDoc = { space, limits: noEq || !logistics ? [] : withRuleLimit(profiles.map(limitSnapshot), logistics), packs: {}, pallets: {}, units: [] }
    const ctx: ToolContext = { user: me, draft: empty, logistics }
    const packs = new Map((await currentPackCatalog()).map((x) => [x.sku.toUpperCase(), x]))
    const units = new Map<string, number>()
    const notes: string[] = []
    for (const [i, l] of d.lines.entries()) {
      const pack = packs.get(l.sku!.toUpperCase())
      if (!pack) return { ok: false, error: `Linha ${i + 1}: ${l.sku} sem embalagem cadastrada (medidas/pesos) — não dá para montar.` }
      const r = unitsFor(l.quantity!, l.unit, pack)
      if ('error' in r) return { ok: false, error: `Linha ${i + 1} (${pack.sku}): ${r.error}.` }
      let n: number
      if ('pallets' in r) {
        const info = await executeTool(ctx, 'get_product_logistics', { sku: pack.sku })
        const per = (info.result as { referencePallet?: { productUnitsPerPallet?: number } }).referencePallet?.productUnitsPerPallet
        if (!per) return { ok: false, error: `Linha ${i + 1} (${pack.sku}): não foi possível calcular as unidades de um palete completo (faltam dados no cadastro).` }
        n = per * r.pallets
        notes.push(`${pack.sku}: ${r.pallets} palete(s) completo(s) = ${n} un.`)
      } else {
        n = r.units
        if (r.note) notes.push(`${pack.sku}: ${r.note}`)
      }
      units.set(pack.sku, (units.get(pack.sku) ?? 0) + n)
    }

    let docs: LoadDoc[]
    if (service === 'COURIER') {
      // courier: cada caixa vira um volume (unidades → caixas, arredondando para cima)
      for (const [sku, n] of units) {
        const pk = packs.get(sku.toUpperCase())!
        const boxes = Math.ceil(n / Math.max(1, pk.unitsPerPackage))
        const r = await executeTool(ctx, 'add_loose_boxes', { sku, quantity: boxes })
        if (!r.ok) return { ok: false, error: `Não foi possível montar os volumes (${sku}): ${(r.result as { error?: string }).error ?? 'erro do motor'}`, notes }
      }
      docs = [ctx.draft]
    } else if (noEq) {
      // sem equipamento: paletes mistos no piso virtual (altura máxima do tipo)
      const r = await executeTool(ctx, 'optimize_mixed_pallets', { lines: [...units].map(([sku, n]) => ({ sku, units: n })), mode: TYPE_INFO[service].plannerMode, max_height_mm: space.inner.h, apply: true })
      const rr = r.result as { error?: string }
      if (!r.ok || rr.error) return { ok: false, error: `Não foi possível montar os paletes: ${rr.error ?? 'erro do motor'}`, notes }
      docs = [ctx.draft]
    } else {
      // montagem pelo motor: paletes mistos com a regra logística e divisão em unidades se não couber
      const split = await executeTool(ctx, 'split_into_units', { lines: [...units].map(([sku, n]) => ({ sku, units: n })) })
      const sr = split.result as { error?: string; didNotFit?: unknown[]; notes?: string[] }
      if (!split.ok || sr.error) return { ok: false, error: `Não foi possível montar a carga: ${sr.error ?? 'erro do motor'}`, notes }
      notes.push(...(sr.notes ?? []), ...(ctx.unitNotes ?? []))
      docs = [ctx.draft, ...(ctx.extraUnits ?? [])]
    }

    // conferência pedido × carga: se não coube TUDO o que foi pedido, não cria nada e mostra o que faltou
    const loaded = new Map<string, number>()
    for (const doc of docs) for (const l of docOrderLines(doc)) loaded.set(l.pack.sku.toUpperCase(), (loaded.get(l.pack.sku.toUpperCase()) ?? 0) + l.boxes * l.pack.unitsPerPackage)
    const short = [...units].map(([sku, n]) => ({ sku, n, got: loaded.get(sku.toUpperCase()) ?? 0 })).filter((x) => x.got < x.n)
    if (short.length)
      return {
        ok: false,
        error: `Não coube todo o pedido — nada foi criado. Faltou: ${short.map((x) => `${x.sku} ${x.got.toLocaleString('pt-BR')} de ${x.n.toLocaleString('pt-BR')} un.`).join('; ')}. Ajuste as quantidades, o equipamento/tipo de envio ou a altura máxima.`,
        notes,
      }

    const customer = d.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.id, d.customerId) }) : null
    if (d.customerId && !customer) return { ok: false, error: 'Cliente não encontrado.' }
    const orderRef = normalizeOrderRef(d.orderRef)
    const baseName = autoPlanName(orderRef, space.code, d.country, area)
    const changelog = ['Criada a partir do pedido do cliente (assistente IA)', ...notes].join('\n').slice(0, 4000)

    const planIds = await db.transaction(async (tx) => {
      let customerId = customer?.id
      if (!customerId) {
        ;[{ id: customerId }] = await tx.insert(schema.customers).values({ name: d.newCustomer.trim(), country: d.country, address: placeValue(d.customerAddress), createdBy: me.id, updatedBy: me.id }).returning({ id: schema.customers.id })
      } else if (placeValue(d.customerAddress)) {
        // cliente criado pela tela e ainda sem endereço: guarda o informado. Nunca nos clientes do ERP (com código)
        // nem em quem já tem algum campo do endereço (rua, complemento, bairro, CEP, cidade, estado)
        await tx
          .update(schema.customers)
          .set({ address: placeValue(d.customerAddress), updatedAt: new Date(), updatedBy: me.id })
          .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.code), ...CUSTOMER_ADDRESS_FIELDS.map((k) => isNull(schema.customers[k]))))
      }
      const [sh] = await tx
        .insert(schema.shipments)
        .values({ customerId, orderRef, destinationCountry: d.country, incoterm: d.incoterm, cfop, mode, service, area, originPlace: placeValue(d.originPlace), destinationPlace: placeValue(d.destinationPlace), customerAddress: placeValue(d.customerAddress), notes: d.notes || null, createdBy: me.id, updatedBy: me.id })
        .returning({ id: schema.shipments.id })
      const ids: number[] = []
      for (const [k, doc] of docs.entries()) {
        const ev = evaluateDoc(doc)
        const [lp] = await tx
          .insert(schema.loadPlans)
          .values({ shipmentId: sh.id, name: docs.length > 1 ? `${baseName} · ${unitNoun(doc.space)} ${k + 1}` : baseName, agentId: customer?.agentId ?? null, transportCompanyId, paymentTerms, createdBy: me.id, updatedBy: me.id })
          .returning({ id: schema.loadPlans.id })
        await tx.insert(schema.loadPlanVersions).values({
          loadPlanId: lp.id,
          version: 1,
          status: 'DRAFT',
          ...versionSpaceColumns(doc.space),
          document: doc,
          summary: ev.stored,
          issues: ev.issues,
          criticalCount: ev.critical,
          warningCount: ev.warning,
          changelog,
          createdBy: me.id,
          updatedBy: me.id,
        })
        ids.push(lp.id)
      }
      return ids
    })
    await lockPackagingVersions(docs.flatMap(packagingIds))
    await logAudit('load_plan', planIds[0], 'create_from_intake', me.id, { planIds, lines: d.lines.length, units: Object.fromEntries(units), transportCompanyId, paymentTerms, cfop })
    revalidatePath('/')
    return { ok: true, planId: planIds[0], units: docs.length, notes }
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message }
    console.error('[pedido do cliente → carga]', e)
    return { ok: false, error: 'Não foi possível criar o pedido. Nada foi gravado.' }
  }
}
