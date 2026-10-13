/**
 * SIMULA a importação do catálogo oficial contra o banco LOCAL, sem gravar nada:
 *  1. lê as duas planilhas e monta o plano (o mesmo da prévia da tela Manutenção);
 *  2. mostra o resumo e os avisos;
 *  3. grava uma prévia TEMPORÁRIA, aplica com dryRun (transação desfeita no fim) e apaga a prévia.
 * As prévias da tela não são tocadas. Recusa rodar contra o Neon (produção).
 * Uso: npx tsx --env-file=.env scripts/catalog-import-dry-run.ts <produtos.xlsx> <caixas.xlsx> [--json saida.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { applyCatalogImport } from '../src/lib/catalogImport/apply'
import { buildPlanFromSheets } from '../src/lib/catalogImport/preview'

async function main() {
  // produção nunca: o script grava (e desfaz) dentro do banco apontado por DATABASE_URL
  if (/neon\.tech/i.test(process.env.DATABASE_URL ?? '')) throw new Error('DATABASE_URL aponta para o Neon (produção): este script só roda no banco local.')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente (use --env-file=.env).')
  const args = process.argv.slice(2)
  const jsonAt = args.indexOf('--json')
  const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null
  const [produtos, caixas] = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1))
  if (!produtos || !caixas) throw new Error('Uso: npx tsx --env-file=.env scripts/catalog-import-dry-run.ts <produtos.xlsx> <caixas.xlsx> [--json saida.json]')

  const t0 = Date.now()
  const plan = await buildPlanFromSheets({
    products: { name: basename(produtos), buf: readFileSync(produtos) },
    boxes: { name: basename(caixas), buf: readFileSync(caixas) },
  })
  console.log(`Plano montado em ${((Date.now() - t0) / 1000).toFixed(1)} s (motor ${plan.engineVersion}, decisões ${plan.decisionsId})`)
  const sum = plan.summary
  console.log(`
Planilha: ${sum.sheetRows} linhas · ${sum.parsedRows} lidas · ${sum.skippedRows} ignoradas
Repetidos: ${sum.duplicateGroups} grupos · ${sum.duplicatesDiscarded} descartados
Produtos: ${sum.planned} (criar ${sum.toCreate} · atualizar ${sum.toUpdate}) · com caixa ${sum.withPackaging} (alta ${sum.confidence.HIGH} · média ${sum.confidence.MEDIUM}) · pendentes ${sum.pending}
EAN: EAN-13 ${sum.ean.EAN13} · GTIN-14 ${sum.ean.GTIN14} · inválidos ${sum.ean.INVALID} · sem ${sum.ean.missing}
Brutos recalculados: ${sum.grossReplaced} · desativados: ${sum.deactivations} · montagens estimadas: ${sum.refPalletsEstimate}
Famílias novas: ${sum.newFamilies.join(', ') || '—'} · linhas novas: ${sum.newLines.join(', ') || '—'}
Sem produtos ativos depois: ${sum.familiesWithoutActiveProducts.join(', ') || '—'}`)
  console.log('\nPor família:')
  for (const f of sum.byFamily) console.log(`  ${f.name.padEnd(22)} ${String(f.total).padStart(4)}  com caixa ${String(f.withPackaging).padStart(4)}  pendentes ${String(f.pending).padStart(4)}`)
  const reasons = new Map<string, number>()
  for (const p of plan.pending) reasons.set(p.reasonCode, (reasons.get(p.reasonCode) ?? 0) + 1)
  console.log(`\nPendentes por motivo: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`)
  console.log('\nAvisos:')
  for (const w of plan.warnings) console.log(`  [${w.level}] ${w.code}: ${w.message}${w.codes?.length ? ` (${w.codes.length} cód.)` : ''}`)
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(plan, null, 1))
    console.log(`\nPlano completo gravado em ${jsonOut}`)
  }

  // prévia temporária só para simular a aplicação (não substitui as prévias da tela)
  const [tmp] = await db
    .insert(s.catalogImports)
    .values({
      status: 'PREVIEW',
      engineVersion: plan.engineVersion,
      productsFile: plan.files.products.name,
      productsSha256: plan.files.products.sha256,
      boxesFile: plan.files.boxes.name,
      boxesSha256: plan.files.boxes.sha256,
      catalogFingerprint: plan.catalogFingerprint,
      plan,
      summary: plan.summary,
    })
    .returning({ id: s.catalogImports.id })
  try {
    if (plan.warnings.some((w) => w.level === 'BLOCKER')) {
      console.log('\nA prévia tem BLOQUEIOS: a aplicação não seria permitida (simulação pulada).')
      return
    }
    // autor da simulação (desfeita): o primeiro administrador (catalog_import.applied_by exige um usuário)
    const [admin] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.role, 'ADMIN')).orderBy(asc(s.users.id)).limit(1)
    if (!admin) throw new Error('Nenhum usuário ADMIN no banco local.')
    const r = await applyCatalogImport(tmp.id, admin.id, { dryRun: true })
    console.log(`
SIMULAÇÃO DA APLICAÇÃO (transação desfeita):
  famílias criadas: ${r.familiesCreated.join(', ') || '—'}
  linhas criadas: ${r.linesCreated.join(', ') || '—'}
  produtos criados ${r.variantsCreated} · atualizados ${r.variantsUpdated}
  embalagens novas ${r.packagingCreated} · alteradas ${r.packagingNewVersions} · sem mudança ${r.packagingUnchanged} · produtos sem caixa ${r.pendingWithoutPackaging}
  desativados ${r.deactivated} · reativados: ${r.reactivated.join(', ') || '—'}
  duração ${(r.durationMs / 1000).toFixed(1)} s`)
  } finally {
    await db.delete(s.catalogImports).where(eq(s.catalogImports.id, tmp.id))
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
