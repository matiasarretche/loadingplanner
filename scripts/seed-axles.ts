/**
 * Valores de referência para a distribuição por eixo (pesquisados em fontes públicas, out/2026).
 * Tudo entra como ESTIMADO/NÃO VERIFICADO e é editável em Cadastros. Idempotente (upsert por código);
 * veículos existentes só recebem a geometria se ainda não tiverem (não sobrescreve edições).
 *
 *   npx tsx --env-file=.env scripts/seed-axles.ts [--dry]
 */
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'

const dry = process.argv.includes('--dry')

const CONTRAN = 'Resolução CONTRAN nº 882/2021, art. 6º (I-c/d, II, III, V, VII) e art. 50 (tolerâncias) — https://www.gov.br/transportes/pt-br/assuntos/transito/conteudo-contran/resolucoes/Resolucao8822021.pdf'
const MERCOSUL = 'Decreto AR 209/1992 (pesos e dimensões para o tráfego internacional MERCOSUL) — https://www.argentina.gob.ar/normativa/nacional/decreto-209-1992-8253/texto'
const AR = 'Decreto AR 32/2018, tabela de pesos máximos (suspensão mecânica) — https://www.argentina.gob.ar/sites/default/files/pesos_maximos.pdf'
const UY = 'Decreto UY 311/007, item 2.3 (modifica o Decreto 326/986) — https://www.impo.com.uy/bases/decretos-originales/311-2007/1'
const CL = 'Decreto Supremo MOP 158/1980 (texto atualizado; DS 181/2025 eixo direcional 7,35 t com pneu ≥ 315 mm) — https://vialidad.mop.gob.cl/uploads/sites/9/2025/01/1-DECRETO-NUMERO-158-de-1980_TRANSCRIPCION.pdf'

const profiles: (typeof s.axleLimitProfiles.$inferInsert)[] = [
  {
    code: 'BR-CONTRAN-882', name: 'Brasil — CONTRAN 882/2021', country: 'BR',
    steerKg: 6000, singleDualKg: 10000, tandem2Kg: 17000, tandem3Kg: 25500, maxGrossKg: 54500,
    warnPct: 95, axleTolPct: 12.5, grossTolPct: 5, validFrom: '2022-01-03', verification: 'ESTIMATED', source: CONTRAN,
    notes: 'PBTC 54,5 t = cavalo + semirreboque com tandem triplo e comprimento > 16 m (art. 6º I-d); com comprimento < 16 m o limite é 45 t (I-c). Tandem duplo 17 t vale com distância entre eixos > 1,20 m e ≤ 2,40 m. As tolerâncias de 12,5% (eixo) e 5% (PBTC) são só de fiscalização: o art. 50 § 3º proíbe incorporá-las ao carregamento. Alerta a partir de 95% = critério interno (editável), não é norma.',
  },
  {
    code: 'MERCOSUL', name: 'MERCOSUL — tráfego internacional', country: null,
    steerKg: 6000, singleDualKg: 10500, tandem2Kg: 18000, tandem3Kg: 25500, maxGrossKg: 45000,
    warnPct: 95, axleTolPct: null, grossTolPct: null, verification: 'ESTIMATED', source: MERCOSUL,
    notes: 'Acordo de pesos e dimensões para o tráfego internacional entre os países do MERCOSUL. No trecho brasileiro valem também os limites do CONTRAN (tandem duplo 17 t, eixo simples rodado duplo 10 t).',
  },
  {
    code: 'AR-DEC-32-2018', name: 'Argentina — Decreto 32/2018 (susp. mecânica)', country: 'AR',
    steerKg: 6000, singleDualKg: 10500, tandem2Kg: 18000, tandem3Kg: 25500, maxGrossKg: null,
    warnPct: 95, verification: 'ESTIMATED', source: AR,
    notes: 'Com suspensão pneumática: eixo simples rodado duplo 11 t, tandem duplo 18,9 t, tandem triplo 26,8 t, direcional 6,3 t. PBTC não confirmado na fonte consultada — para tráfego internacional use o perfil MERCOSUL (45 t).',
  },
  {
    code: 'UY-DEC-311-2007', name: 'Uruguai — Decreto 311/007', country: 'UY',
    steerKg: 6000, singleDualKg: 10500, tandem2Kg: 18000, tandem3Kg: 25500, maxGrossKg: null,
    warnPct: 95, verification: 'ESTIMATED', source: UY,
    notes: 'Tandem triplo 25,5 t ou 22 t conforme a rota. O decreto não fixa um PBT único (exige relação potência/peso acima de 45 t) — para tráfego internacional use o perfil MERCOSUL (45 t).',
  },
  {
    code: 'CL-DS-158', name: 'Chile — DS 158/1980', country: 'CL',
    steerKg: 7000, singleDualKg: 11000, tandem2Kg: 18000, tandem3Kg: 25000, maxGrossKg: 45000,
    warnPct: 95, verification: 'ESTIMATED', source: CL,
    notes: 'Eixo simples de rodado simples 7 t (7,35 t com pneu ≥ 315 mm, DS 181/2025). PBT 45 t independentemente do número de eixos (acima disso só com autorização da Dirección de Vialidad).',
  },
  {
    code: 'PY-REF', name: 'Paraguai — referência', country: 'PY',
    steerKg: 6000, singleDualKg: 10500, tandem2Kg: 18000, tandem3Kg: 25500, maxGrossKg: 45000,
    warnPct: 95, verification: 'UNVERIFIED', source: 'Fonte secundária (resumo da norma MOPC); valores iguais aos do acordo MERCOSUL.',
    notes: 'Não foi encontrada a norma oficial do MOPC (citada como Resolução 1762/97). Confirmar antes de usar.',
  },
]

const VOLVO_6X2 = 'Volvo FH 6x2T (susp. pneumática), versão 3700 — ficha técnica Volvo do Brasil 19/07/2021'
const VOLVO_4X2 = 'Volvo FH 4x2T, versão 3700 — ficha técnica Volvo do Brasil 03/10/2022'
const tractors: (typeof s.roadTractors.$inferInsert)[] = [
  {
    code: 'CAVALO-6X2', name: 'Cavalo 6x2 (ref. Volvo FH 6x2T 3700)', country: 'BR',
    wheelbaseMm: 3700 + 1370 / 2, fifthWheelAheadMm: 450, rearGroup: 'TANDEM2', rearSpacingMm: 1370,
    tareFrontKg: 5372, tareRearKg: 3923, techFrontKg: 7500, techRearKg: 20500, verification: 'ESTIMATED', source: VOLVO_6X2,
    notes: 'Entre-eixos 3700 mm (dianteiro → 1º traseiro) + 1370/2 até o centro do tandem = 4385 mm. Posição da 5ª roda 450 mm (cota F da ficha; assumida à frente do centro do tandem). Taras em ordem de marcha, sem motorista (tolerância 3%).',
  },
  {
    code: 'CAVALO-4X2', name: 'Cavalo 4x2 (ref. Volvo FH 4x2T 3700)', country: 'BR',
    wheelbaseMm: 3700, fifthWheelAheadMm: 250, rearGroup: 'SINGLE_DUAL', rearSpacingMm: 0,
    tareFrontKg: 5366, tareRearKg: 2579, techFrontKg: null, techRearKg: null, verification: 'ESTIMATED', source: VOLVO_4X2,
    notes: 'Posição da 5ª roda 250 mm (cota da ficha; assumida à frente do eixo traseiro). Taras em ordem de marcha, sem motorista.',
  },
]

// Semirreboques: pino-rei 1200 mm da frente e tandem triplo 1310 mm (ficha de semirreboque 40' tri-eixo, extrucks.com),
// balanço traseiro 2410 mm a partir do centro do tandem (mesma ficha: 1200 + 7500 + 1310 = 10010 em 12420 mm).
const SR_SRC = 'Geometria de referência: semirreboque tri-eixo 12,42 m (pino-rei 1200 mm, eixos 7500 + 1310 + 1310 mm, tara 6000 kg — extrucks.com); tara 12,5 m carga seca 3 eixos ≈ 7050 kg (aizimplementos.com.br). Demais comprimentos por proporção.'
const trailerGeo = (len: number, group: 'TANDEM2' | 'TANDEM3', tare: number) => ({
  carrierKind: 'SEMITRAILER' as const,
  lengthMm: len,
  kingpinMm: 1200,
  axleGroup: group,
  axleGroupCenterMm: len - 2410,
  axleSpacingMm: 1310,
  tareKg: tare,
  cargoStartMm: 0,
})
const vehicleGeo: Record<string, Partial<typeof s.vehicleTypes.$inferInsert>> = {
  'SR-CURTO': { ...trailerGeo(10500, 'TANDEM2', 5900), notes: 'Semirreboque curto assumido com 2 eixos (tandem duplo). Confirmar.' },
  'SR-12.5': trailerGeo(12500, 'TANDEM3', 7050),
  'SR-13.6': trailerGeo(13600, 'TANDEM3', 7700),
  'SR-14.6': trailerGeo(14600, 'TANDEM3', 8250),
  RIGIDO: {
    carrierKind: 'RIGID', lengthMm: 8500, frontAxleAheadMm: 1000, axleGroup: 'TANDEM2', axleGroupCenterMm: 4900, axleSpacingMm: 1350,
    tareKg: 9500, tareCgMm: 1655, cargoStartMm: 0,
    notes: 'Truck 6x2 estimado: eixo dianteiro 1000 mm à frente da carroceria, centro do tandem a 4900 mm da frente da carroceria (entre-eixos ≈ 5,9 m até o centro), tara 9,5 t com 55% no dianteiro. Confirmar com o veículo real.',
  },
}

const chassis: typeof s.vehicleTypes.$inferInsert = {
  code: 'PC-40-3E', name: 'Porta-contêiner 40′ 3 eixos (chassi esqueleto)', kind: 'Porta-contêiner', country: 'BR',
  innerLengthMm: 12420, innerWidthMm: 2480, innerHeightMm: 0, doorWidthMm: 0, doorHeightMm: 0,
  tareKg: 6000, carrierKind: 'CHASSIS', lengthMm: 12420, kingpinMm: 1200, axleGroup: 'TANDEM3', axleGroupCenterMm: 10010, axleSpacingMm: 1310, cargoStartMm: 0,
  verification: 'ESTIMATED', source: 'extrucks.com — 40 ft skeleton trailer tri-axle: 12420 mm, pino-rei 1200 mm, eixos 7500 + 1310 + 1310 mm, tara 6000 kg',
  notes: 'Leva 1 × 40′ ou 1 × 20′ (na frente, centralizado ou atrás). Não aparece como espaço de carga: é usado na distribuição por eixo de cargas em contêiner.',
}

async function main() {
  const log: string[] = []
  for (const p of profiles) {
    const cur = await db.query.axleLimitProfiles.findFirst({ where: eq(s.axleLimitProfiles.code, p.code) })
    log.push(`${cur ? '=' : '+'} limite ${p.code}`)
    if (!dry && !cur) await db.insert(s.axleLimitProfiles).values(p)
  }
  for (const t of tractors) {
    const cur = await db.query.roadTractors.findFirst({ where: eq(s.roadTractors.code, t.code) })
    log.push(`${cur ? '=' : '+'} cavalo ${t.code}`)
    if (!dry && !cur) await db.insert(s.roadTractors).values(t)
  }
  for (const [code, geo] of Object.entries(vehicleGeo)) {
    const v = await db.query.vehicleTypes.findFirst({ where: eq(s.vehicleTypes.code, code) })
    if (!v) {
      log.push(`? veículo ${code} não existe`)
      continue
    }
    if (v.carrierKind) {
      log.push(`= veículo ${code} já tem geometria`)
      continue
    }
    log.push(`~ veículo ${code}: geometria de eixos + tara ${geo.tareKg} kg`)
    const notes = [v.notes, geo.notes ?? null].filter(Boolean).join('\n') || null
    if (!dry)
      await db
        .update(s.vehicleTypes)
        .set({ ...geo, notes, verification: v.verification === 'VERIFIED' ? 'ESTIMATED' : v.verification, source: v.source ?? (code === 'RIGIDO' ? 'Estimativa interna (ver observações)' : SR_SRC), updatedAt: new Date() })
        .where(eq(s.vehicleTypes.id, v.id))
  }
  const ch = await db.query.vehicleTypes.findFirst({ where: eq(s.vehicleTypes.code, chassis.code) })
  log.push(`${ch ? '=' : '+'} chassi ${chassis.code}`)
  if (!dry && !ch) await db.insert(s.vehicleTypes).values(chassis)
  console.log((dry ? '[simulação]\n' : '') + log.join('\n'))
  process.exit(0)
}
main()
