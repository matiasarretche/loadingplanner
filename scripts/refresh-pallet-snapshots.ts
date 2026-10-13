/** Atualiza os dados do palete dentro de todas as montagens ativas. Uso: npx tsx --env-file=.env scripts/refresh-pallet-snapshots.ts */
import { refreshPalletSnapshots } from '../src/lib/refreshPalletSnapshots'

refreshPalletSnapshots().then(
  (r) => {
    console.log(`Montagens atualizadas: ${r.updated}`)
    process.exit(0)
  },
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
