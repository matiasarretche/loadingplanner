/**
 * Cadastra ULDs aéreas de REFERÊNCIA (modal AIR) se ainda não existirem.
 * Medidas úteis simplificadas como caixa (o contorno real depende da aeronave e do deck):
 * confirmar com a companhia aérea antes de usar.
 * Uso: npx tsx --env-file=.env scripts/seed-uld.ts
 */
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'

const SOURCE = 'Referência IATA ULD (valores típicos) — confirmar com a companhia aérea'
const ULDS = [
  {
    code: 'PMC',
    name: 'Pallet aéreo PMC/P6P 96" × 125" (main deck, contorno simplificado)',
    innerLengthMm: 3175, innerWidthMm: 2438, innerHeightMm: 1600,
    doorWidthMm: 2438, doorHeightMm: 1600, tareKg: 120, maxGrossKg: 6804, maxPayloadKg: 6684,
    notes: 'Altura útil de 1.600 mm (compatível com lower deck de widebody). No main deck de cargueiro pode chegar a ~2.440/3.000 mm conforme o contorno.',
  },
  {
    code: 'PAG',
    name: 'Pallet aéreo PAG/P1P 88" × 125" (contorno simplificado)',
    innerLengthMm: 3175, innerWidthMm: 2235, innerHeightMm: 1600,
    doorWidthMm: 2235, doorHeightMm: 1600, tareKg: 110, maxGrossKg: 6033, maxPayloadKg: 5923,
    notes: 'Altura útil de 1.600 mm (lower deck). No main deck de cargueiro pode ser maior conforme o contorno.',
  },
  {
    code: 'AKE-LD3',
    name: 'Contêiner aéreo AKE / LD3 (lower deck, contorno simplificado)',
    innerLengthMm: 1460, innerWidthMm: 1430, innerHeightMm: 1570,
    doorWidthMm: 1430, doorHeightMm: 1500, tareKg: 82, maxGrossKg: 1588, maxPayloadKg: 1506,
    notes: 'Base 1.534 × 1.562 mm; o lado chanfrado reduz o volume real (~4,3 m³).',
  },
]

async function main() {
  for (const u of ULDS) {
    const cur = await db.query.containerTypes.findFirst({ where: eq(s.containerTypes.code, u.code) })
    if (cur) {
      console.log(`${u.code}: já existe`)
      continue
    }
    await db.insert(s.containerTypes).values({ ...u, transportMode: 'AIR', verification: 'ESTIMATED', source: SOURCE })
    console.log(`${u.code}: cadastrada`)
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
