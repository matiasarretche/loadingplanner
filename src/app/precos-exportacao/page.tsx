import { asc, desc, eq } from 'drizzle-orm'
import { dtSec } from '@/components/format'
import { db, schema } from '@/db'
import type { PriceMethod } from '@/domain/exportPricing'
import { familyTech } from '@/domain/technology'
import { canAccessArea } from '@/lib/areas'
import { requireUser } from '@/lib/auth'
import { productRank, rankOf } from '@/lib/catalog'
import { ALL_COUNTRY_CODES, countryCode, countryNamePt } from '@/lib/countries'
import { catalogPricedProducts, CIF_SETTING, loadPriceBands, loadPriceTwins } from '@/lib/exportPricing'
import { issuedQuotesView } from '@/lib/loadPricing'
import { priceListItems } from '@/lib/priceList'
import { can } from '@/lib/roles'
import { ExportPricesClient } from './ExportPricesClient'

// a server action do assistente da lista de preços (priceListAssistAction) chama a IA: tempo máximo do plano Hobby da Vercel
export const maxDuration = 300

/**
 * PREÇOS DE EXPORTAÇÃO: categorias de mercado, países por categoria, regra e preço (USD/kg líquido
 * e, quando a regra pede, valor fixo USD/unidade) por família, preços resultantes dos produtos do
 * catálogo e histórico de alterações. Base das futuras Proformas.
 */
export default async function PrecosExportacaoPage() {
  const u = await requireUser()
  if (!canAccessArea(u, 'EXPORT') || !can.viewPrices(u.role))
    return (
      <div className="panel">
        <h1>Preços de exportação</h1>
        <p className="muted">Disponível só para usuários da área de Exportação.</p>
      </div>
    )
  const [categories, countries, families, rules, prices, history, users, shipments, products, rank, brandAdj, agents, commissions, quotes, settings, listItems, twins, bands, bandRows, bandPriceRows] = await Promise.all([
    db.select().from(schema.priceCategories).orderBy(asc(schema.priceCategories.sort), asc(schema.priceCategories.code)),
    db.select().from(schema.countryPriceCategories),
    db.select().from(schema.productFamilies).where(eq(schema.productFamilies.active, true)).orderBy(asc(schema.productFamilies.sort), asc(schema.productFamilies.name)),
    db.select().from(schema.familyPriceRules),
    db.select().from(schema.familyPrices),
    db.select().from(schema.priceHistory).orderBy(desc(schema.priceHistory.at)).limit(300),
    db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users),
    db.select({ c: schema.shipments.destinationCountry }).from(schema.shipments).where(eq(schema.shipments.area, 'EXPORT')),
    catalogPricedProducts(),
    productRank(),
    db.select().from(schema.brandPriceAdjustments),
    db.select().from(schema.agents).orderBy(asc(schema.agents.name)),
    db.select().from(schema.commissionRates),
    issuedQuotesView({ limit: 1000 }),
    db.select().from(schema.exportPriceSettings),
    priceListItems(),
    loadPriceTwins(),
    loadPriceBands(),
    db.select().from(schema.familyPriceBands),
    db.select().from(schema.familyBandPrices),
  ])
  const uname = new Map(users.map((x) => [x.id, x.name]))
  // países: TODOS (para atribuir qualquer um) + já atribuídos + destinos de cargas de exportação
  const codes = new Set<string>([...ALL_COUNTRY_CODES, ...countries.map((c) => c.countryCode), ...shipments.map((s) => countryCode(s.c)).filter((c): c is string => Boolean(c))])
  codes.delete('BR')
  const assigned = new Map(countries.map((c) => [c.countryCode, c]))
  return (
    <ExportPricesClient
      canEdit={can.editCatalog(u.role)}
      categories={categories.map((c) => ({ id: c.id, code: c.code, name: c.name, sort: c.sort, active: c.active }))}
      countries={[...codes]
        .map((code) => ({ code, name: countryNamePt(code), categoryId: assigned.get(code)?.categoryId ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))}
      families={families.map((f) => {
        const r = rules.find((x) => x.familyId === f.id)
        return {
          id: f.id,
          name: f.name,
          // tecnologia comercial do Catálogo (PACIFIL NXT: menção ou selo) — padrão do NXT na lista de preços
          tech: familyTech(f),
          method: (r?.method ?? 'PER_KG') as PriceMethod,
          refFamilyId: r?.refFamilyId ?? null,
          cifUsdPerKg: r?.cifUsdPerKg ?? null,
          markupPct: r?.markupPct ?? null,
          // faixas de diâmetro (Silo-bolsa): USD/kg por faixa e categoria
          bands: bandRows
            .filter((b) => b.familyId === f.id)
            .sort((a, b) => a.sort - b.sort || a.minFt - b.minFt)
            .map((b) => ({ key: b.key, label: b.label, minFt: b.minFt, maxFt: b.maxFt })),
          bandPrices: bandPriceRows
            .filter((p) => p.familyId === f.id)
            .map((p) => ({ categoryId: p.categoryId, bandKey: p.bandKey, usdPerKg: p.usdPerKg, at: p.updatedAt.toISOString(), updated: `${dtSec(p.updatedAt)}${p.updatedBy ? ` · ${uname.get(p.updatedBy) ?? ''}` : ''}` })),
          prices: prices
            .filter((p) => p.familyId === f.id)
            .map((p) => ({ categoryId: p.categoryId, usdPerKg: p.usdPerKg, fixedUsdPerUnit: p.fixedUsdPerUnit, updated: `${dtSec(p.updatedAt)}${p.updatedBy ? ` · ${uname.get(p.updatedBy) ?? ''}` : ''}` })),
        }
      })}
      products={products.sort((a, b) => rankOf(rank, a.sku) - rankOf(rank, b.sku)).map((p) => ({ sku: p.sku, name: p.name, brand: p.brand ?? null, familyId: p.familyId, family: p.family, netKg: p.netKg }))}
      brands={[...new Set(products.map((p) => p.brand ?? 'Pacifil'))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((b) => {
          const a = brandAdj.find((x) => x.brand.toLowerCase() === b.toLowerCase())
          return { brand: b, pct: a?.pct ?? 0, products: products.filter((p) => (p.brand ?? 'Pacifil') === b).length, updated: a ? `${dtSec(a.updatedAt)}${a.updatedBy ? ` · ${uname.get(a.updatedBy) ?? ''}` : ''}` : null }
        })}
      quotes={quotes}
      listItems={listItems}
      priceTwin={[...twins]}
      skuDiameterFt={[...(bands.skuDiameterFt ?? [])]}
      cifDefault={settings.find((x) => x.key === CIF_SETTING)?.value ?? null}
      agents={agents.map((a) => ({ id: a.id, name: a.name, active: a.active }))}
      commissions={commissions.map((c) => ({ agentId: c.agentId, familyId: c.familyId, pct: c.pct, updated: `${dtSec(c.updatedAt)}${c.updatedBy ? ` · ${uname.get(c.updatedBy) ?? ''}` : ''}` }))}
      history={history.map((h) => ({
        id: h.id,
        at: dtSec(h.at),
        user: h.userId ? uname.get(h.userId) ?? `#${h.userId}` : '—',
        kind: h.kind,
        familyId: h.familyId,
        categoryId: h.categoryId,
        countryCode: h.countryCode,
        field: h.field,
        oldValue: h.oldValue,
        newValue: h.newValue,
      }))}
    />
  )
}
