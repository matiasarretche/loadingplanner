/**
 * Sincroniza as montagens de palete com o catálogo atual e cria as REF que faltam.
 * Uso: npx tsx --env-file=.env scripts/refresh-compositions.ts [--dry]
 */
import { refreshCompositions } from '../src/lib/refreshCompositions'
import { generateReferencePallets } from '../src/lib/referencePallets'

async function main() {
  const dry = process.argv.includes('--dry')
  const r = await refreshCompositions({ dry })
  console.log((dry ? '[SIMULAÇÃO]\n' : '') + r.lines.join('\n'))
  console.log(`\nAtualizadas: ${r.updated} · recalculadas: ${r.regenerated} · arquivadas: ${r.archived} · revisar: ${r.review}`)
  if (!dry) {
    const g = await generateReferencePallets(null)
    if (g.created) console.log(`\nREF novas (SKUs sem montagem):\n${g.lines.join('\n')}`)
    console.log(`REF criadas: ${g.created}`)
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
