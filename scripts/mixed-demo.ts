/**
 * Demonstração do otimizador de paletes mistos com dados reais do catálogo.
 * Uso: npx tsx --env-file=.env scripts/mixed-demo.ts
 */
import { eq, inArray, like } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { optimizeMixedPallets, OrderLine, singleSkuBaseline, transportMaxHeight } from '../src/domain/mixedPallets'
import { containerSpace, packSnapshot, palletTypeSnapshot } from '../src/lib/snapshots'

const ORDER: [string, number][] = [
  ['HS-50K', 10],
  ['HS-40K', 10],
  ['HS-30K', 10],
  ['HS-20K', 10],
  ['HS-10K', 20],
  ['HS-5K', 30],
  ['HS-2K', 20],
]

const kg = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`

async function main() {
  const rows = await db.select({ pv: s.packagingVersions, v: s.productVariants }).from(s.packagingVersions).innerJoin(s.productVariants, eq(s.productVariants.id, s.packagingVersions.variantId)).where(like(s.productVariants.sku, 'HS-%'))
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!latest.get(r.v.sku) || r.pv.version > latest.get(r.v.sku)!.pv.version) latest.set(r.v.sku, r)
  const order: OrderLine[] = ORDER.map(([sku, n]) => {
    const r = latest.get(sku)!
    return { packId: `pv${r.pv.id}`, pack: packSnapshot(r.pv, r.v), boxes: n }
  })
  const stdTypeIds = [...new Set(ORDER.map(([sku]) => latest.get(sku)!.pv.palletTypeId).filter((x): x is number => x != null))]
  const types = (await db.select().from(s.palletTypes).where(inArray(s.palletTypes.id, stdTypeIds))).map(palletTypeSnapshot)
  const c40 = (await db.query.containerTypes.findFirst({ where: eq(s.containerTypes.code, '40GP') }))!
  const pmc = (await db.query.containerTypes.findFirst({ where: eq(s.containerTypes.code, 'PMC') }))!

  for (const [label, H] of [
    ['FCL 40GP (altura útil = mín(interna 2.395, porta 2.292))', transportMaxHeight('FCL', containerSpace(c40))!],
    ['AÉREO PMC (altura informada 1.600 mm)', transportMaxHeight('AIR', containerSpace(pmc), 1600)!],
  ] as [string, number][]) {
    const t0 = Date.now()
    const r = optimizeMixedPallets(order, { palletTypes: types, maxHeightMm: H })
    const ms = Date.now() - t0
    console.log(`\n================ ${label} — altura máx. ${H} mm ================`)
    console.log(`Paletes: ${r.totals.pallets} · posições de piso: ${r.positions} · ${r.evaluated} alternativas avaliadas em ${ms} ms`)
    console.log(`Estratégia: ${r.strategy}`)
    r.pallets.forEach((p, i) => {
      const crit = p.issues.filter((x) => x.severity === 'CRITICAL')
      console.log(`\nPALETE ${i + 1} — ${p.doc.palletType.code} ${p.doc.palletType.dims.l}×${p.doc.palletType.dims.w}`)
      for (const l of p.lines) console.log(`  ${l.sku.padEnd(7)} ${String(l.boxes).padStart(3)} un.  (${kg(l.grossKg)})`)
      if (process.argv.includes('--camadas')) {
        const byZ = new Map<number, Map<string, number>>()
        for (const it of p.doc.items) {
          const m = byZ.get(it.pos.z) ?? new Map<string, number>()
          const sku = p.doc.packs[it.packId].sku
          m.set(sku, (m.get(sku) ?? 0) + 1)
          byZ.set(it.pos.z, m)
        }
        for (const [z, m] of [...byZ.entries()].sort((a, b) => b[0] - a[0])) console.log(`     z=${String(z).padStart(4)} mm: ${[...m.entries()].map(([k, n]) => `${n}× ${k}`).join(', ')}`)
      }
      console.log(`  Peso: ${kg(p.grossKg)} · Altura: ${(p.heightMm / 1000).toFixed(3)} m · Ocupação: ${p.volumeUtilPct.toFixed(0)}% · alertas críticos: ${crit.length}${crit.length ? ' → ' + crit.map((x) => x.message).join(' | ') : ''}`)
    })
    console.log(`\nTOTAL: ${r.totals.boxes} caixas · ${kg(r.totals.grossKg)} bruto · ${r.totals.cbm.toFixed(2)} m³ (envelopes)`)
    console.log('Conferência pedido × paletes:', r.check.map((c) => `${c.sku} ${c.placed}/${c.requested}${c.ok ? ' ✓' : ' ✗'}`).join(' · '))
    if (r.unplaced.length) console.log('NÃO COLOCADO:', r.unplaced)
    const base = singleSkuBaseline(order, { palletTypes: types, maxHeightMm: H }, (o) => types.find((t) => t.palletTypeId === latest.get(o.pack.sku)!.pv.palletTypeId))
    console.log(`Comparação — paletes por SKU (sem misturar): ${base.reduce((s, b) => s + b.pallets, 0)} paletes / ${base.reduce((s, b) => s + b.positions, 0)} posições (${base.map((b) => `${b.sku}: ${b.pallets}×${b.perPallet}`).join(', ')})`)
    console.log(`Resultado OK: ${r.ok}`)
  }
  process.exit(0)
}
main()
