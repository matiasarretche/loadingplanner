/**
 * Gera as montagens de referência (REF · SKU · N u).
 * Uso: npx tsx --env-file=.env scripts/generate-reference-pallets.ts [--refresh]
 *   --refresh  recalcula montagens REF já geradas que ninguém editou
 */
import { generateReferencePallets } from '../src/lib/referencePallets'

generateReferencePallets(null, { refreshUnedited: process.argv.includes('--refresh') }).then(
  (r) => {
    console.log(r.lines.join('\n'))
    console.log(`\nMontagens criadas: ${r.created} · recalculadas: ${r.refreshed} · mantidas: ${r.skipped}`)
    process.exit(0)
  },
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
