// Prova de fumaça das tools do assistente contra o banco, sem chamar a IA.
// Uso: npx tsx --conditions=react-server --env-file=.env scripts/ai-tools-smoke.ts
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { containerSpace } from '../src/lib/snapshots'
import { executeTool, ToolContext } from '../src/lib/ai/tools'

async function main() {
  const c = await db.query.containerTypes.findFirst({ where: eq(s.containerTypes.code, '20GP') })
  const ctx: ToolContext = { user: { id: 0, email: 'qa', name: 'QA', role: 'EXPORT_ASSISTANT', mustChangePassword: false, areas: ['EXPORT'], avatar: null }, draft: { space: containerSpace(c!), limits: [], packs: {}, pallets: {}, units: [] } }
  const call = async (name: string, input: unknown) => {
    const r = await executeTool(ctx, name, input)
    const out = r.result as Record<string, unknown>
    const brief = { ...out }
    if (brief.load) brief.load = (brief.load as { totals: unknown }).totals
    if (brief.candidates) brief.candidates = (brief.candidates as { sku: string; matchScore: number }[]).slice(0, 3).map((x) => `${x.sku}(${x.matchScore})`)
    console.log(`\n▶ ${name} ${JSON.stringify(input)}\n  ok=${r.ok} mutated=${r.mutated}\n  ${JSON.stringify(brief).slice(0, 700)}`)
  }
  await call('search_products', { query: 'hidro de 10 mil litros' })
  await call('search_products', { query: 'el de 5k' })
  await call('list_equipment', { kind: 'CONTAINER' })
  await call('add_pallets', { sku: 'HS-10K', fill: true })
  await call('set_equipment', { code: '40HC' })
  await call('add_pallets', { sku: 'HS-10K', fill: true })
  await call('compose_mix', { items: [{ sku: 'HS-5K', percentage: 60 }, { sku: 'HS-20K', percentage: 40 }] })
  await call('remove_pallets', { quantity: 1, which: 'last' })
  await call('replace_product', { from_sku: 'HS-20K', to_sku: 'HS-25K' })
  await call('add_pallets', { sku: 'SB-10x150-235', quantity: 2 })
  await call('add_pallets', { sku: 'NAO-EXISTE', quantity: 2 })
  await call('compose_mix', { items: [{ sku: 'HS-5K', percentage: 70 }, { sku: 'HS-20K', percentage: 20 }] })
  // permissão: visualizador não pode alterar
  ctx.user = { ...ctx.user, role: 'WAREHOUSE_VIEWER' }
  await call('clear_load', {})
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
