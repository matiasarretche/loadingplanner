/**
 * Seed inicial idempotente. Carrega presets de REFERÊNCIA (marcados ESTIMATED/UNVERIFIED)
 * e o usuário ADMIN definido em .env. Rodar: npm run db:seed
 */
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { CONTAINER_PRESETS, PALLET_PRESETS } from '../src/domain/presets'

async function main() {
  // Usuário admin
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  if (email && password) {
    const exists = await db.query.users.findFirst({ where: eq(s.users.email, email.toLowerCase()) })
    if (!exists) {
      await db.insert(s.users).values({
        email: email.toLowerCase(),
        name: process.env.ADMIN_NAME ?? 'Administrador',
        role: 'ADMIN',
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: true,
      })
      console.log(`Admin criado: ${email}`)
    }
  }

  // Famílias Pacifil
  const families = [
    ['SILO_BAG', 'Silo-bolsa'],
    ['SILAGE_TARP', 'Lona de silagem'],
    ['ANIMAL_COMFORT', 'Animal Comfort'],
    ['HIDROSILO', 'Hidrosilo'],
    ['HYDROFORCE', 'Hidroforce'],
    ['ACCESSORY', 'Acessórios'],
  ]
  // PACIFIL NXT nos PDFs comerciais: Hidrosilo com selo; silo-bolsas e lonas só com a menção (editável no Catálogo)
  const tech: Record<string, { technology: string; technologyDisplay: string }> = {
    HIDROSILO: { technology: 'NXT', technologyDisplay: 'SEAL' },
    SILO_BAG: { technology: 'NXT', technologyDisplay: 'MENTION' },
    SILAGE_TARP: { technology: 'NXT', technologyDisplay: 'MENTION' },
  }
  await db
    .insert(s.productFamilies)
    .values(families.map(([code, name], i) => ({ code, name, sort: i + 1, ...tech[code] })))
    .onConflictDoNothing()

  // Paletes
  await db
    .insert(s.palletTypes)
    .values(
      PALLET_PRESETS.map((p) => ({
        code: p.code,
        name: p.name,
        lengthMm: p.l,
        widthMm: p.w,
        heightMm: p.h,
        tareKg: p.tareKg,
        staticMaxKg: p.staticMaxKg,
        dynamicMaxKg: p.dynamicMaxKg,
        material: p.material,
        fourWay: p.fourWay,
        notes: p.notes,
        verification: p.verification,
        source: 'Especificação Pacifil v0.1',
      })),
    )
    .onConflictDoNothing()

  // Contêineres
  await db
    .insert(s.containerTypes)
    .values(
      CONTAINER_PRESETS.map((c) => ({
        code: c.code,
        name: c.name,
        innerLengthMm: c.inner.l,
        innerWidthMm: c.inner.w,
        innerHeightMm: c.inner.h,
        doorWidthMm: c.door.w,
        doorHeightMm: c.door.h,
        tareKg: c.tareKg,
        maxPayloadKg: c.maxPayloadKg,
        maxGrossKg: c.maxGrossKg,
        volumeM3: c.volumeM3,
        source: c.source,
        verification: c.verification,
        notes: 'Referência. Confirmar unidade/naviera para cargas críticas.',
      })),
    )
    .onConflictDoNothing()

  // Veículos: valores INDICATIVOS, sem payload — preencher com dados do transportador.
  const vehicles = [
    ['SR-CURTO', 'Semirreboque curto', 'Semirreboque', 10500, 2480, 2700],
    ['SR-12.5', 'Semirreboque 12,5 m', 'Semirreboque', 12500, 2480, 2700],
    ['SR-13.6', 'Semirreboque 13,6 m', 'Semirreboque', 13600, 2480, 2700],
    ['SR-14.6', 'Semirreboque 14,6 m', 'Semirreboque', 14600, 2480, 2700],
    ['BITREM', 'Bitrem (por conjunto)', 'Bitrem', 18600, 2480, 2700],
    ['RODOTREM', 'Rodotrem (por conjunto)', 'Rodotrem', 25000, 2480, 2700],
    ['RIGIDO', 'Caminhão rígido (truck)', 'Rígido', 8500, 2450, 2600],
  ] as const
  await db
    .insert(s.vehicleTypes)
    .values(
      vehicles.map(([code, name, kind, l, w, h]) => ({
        code,
        name,
        kind,
        country: 'BR',
        innerLengthMm: l,
        innerWidthMm: w,
        innerHeightMm: h,
        doorWidthMm: w,
        doorHeightMm: h,
        tareKg: 0,
        verification: 'UNVERIFIED' as const,
        notes: 'Medidas indicativas. Preencher interno, porta, tara e payload do transportador. Bitrem/rodotrem: modelar cada caixa separadamente se necessário.',
      })),
    )
    .onConflictDoNothing()

  // Perfil operacional padrão (sem limites legais universais)
  const op = await db.query.constraintProfiles.findFirst({ where: eq(s.constraintProfiles.scope, 'OPERATIONAL') })
  if (!op) {
    await db.insert(s.constraintProfiles).values({
      name: 'Operacional Pacifil (padrão)',
      scope: 'OPERATIONAL',
      minSupportPct: 70,
      cgLongTolPct: 10,
      cgLatTolPct: 5,
      lowUtilPct: 50,
      notes: 'Tolerâncias de validação. Limites legais/rota devem ser cadastrados por país/transportador.',
    })
  }

  // Produtos de referência (sem embalagem quando faltam dimensões físicas)
  const fam = Object.fromEntries((await db.select().from(s.productFamilies)).map((f) => [f.code, f.id]))
  async function product(familyCode: string, name: string, variants: { sku: string; name: string; attrs: Record<string, string | number | null>; notes?: string }[]) {
    let p = await db.query.products.findFirst({ where: eq(s.products.name, name) })
    if (!p) [p] = await db.insert(s.products).values({ familyId: fam[familyCode], name }).returning()
    for (const v of variants) {
      // espessura tem campo próprio (thickness_um)
      const { espessura_um, diametro_ft, largura_m, comprimento_m, comprimento_ft, ...attrs } = v.attrs
      const n = (x: unknown) => (typeof x === 'number' ? x : null)
      await db.insert(s.productVariants).values({ productId: p.id, ...v, attrs, thicknessUm: n(espessura_um), diameterFt: n(diametro_ft), widthM: n(largura_m), lengthM: n(comprimento_m), lengthFt: n(comprimento_ft) }).onConflictDoNothing()
    }
  }

  await product('SILO_BAG', 'Silo-bolsa', [
    { sku: 'SB-9x75', name: 'Silo-bolsa 9 ft × 75 m', attrs: { diametro_ft: 9, comprimento_m: 75, capacidade_t: 180 }, notes: 'Capacidade ≈180 t de grão (não é peso de carga).' },
    { sku: 'SB-9x100', name: 'Silo-bolsa 9 ft × 100 m', attrs: { diametro_ft: 9, comprimento_m: 100, capacidade_t: 250 }, notes: 'Capacidade ≈250 t de grão (não é peso de carga).' },
    { sku: 'SB-10x150-235', name: 'Silo-bolsa 10 ft × 150 m × 235 µm', attrs: { diametro_ft: 10, comprimento_m: 150, espessura_um: 235, peso_ref_kg: 315, unid_palete_ref: 4, unid_conteiner_ref: 72 }, notes: 'Ref.: ~315 kg/u; 4 u/palete; histórico 72 u/contêiner. 4×315 kg > 1200 kg do PBR-1: confirmar. Completar dimensões físicas.' },
  ])
  const hs = [5, 8, 10, 16, 20, 24, 25, 30, 32, 40, 50]
  await product(
    'HIDROSILO',
    'Hidrosilo',
    hs.map((k) => ({
      sku: `HS-${k}K`,
      name: `Hidrosilo ${k}.000 L`,
      attrs: { capacidade_l: k * 1000, largura_m: 2, altura_uso_m: 0.5, comprimento_m: k === 5 ? 5.3 : k },
      notes: k === 8 ? 'Ref. ≈25 kg; caixa 2,25×0,38×0,18 m; 33 u/palete (não bate com caixa base 1,15×0,57 — verificar).' : k === 20 ? 'Ref. ≈50 kg; 18 u/palete.' : k >= 40 ? 'Ref. 18 u/palete.' : undefined,
    })),
  )

  // Embalagem de referência do Hidrosilo 8k (dados a verificar)
  const hs8 = await db.query.productVariants.findFirst({ where: eq(s.productVariants.sku, 'HS-8K') })
  if (hs8) {
    const has = await db.query.packagingVersions.findFirst({ where: eq(s.packagingVersions.variantId, hs8.id) })
    if (!has) {
      await db.insert(s.packagingVersions).values({
        variantId: hs8.id,
        version: 1,
        validFrom: '2026-09-29',
        packageType: 'Caixa',
        lengthMm: 2250,
        widthMm: 380,
        heightMm: 180,
        netKg: 25,
        grossKg: 25,
        unitsPerPackage: 1,
        unitsPerPallet: 33,
        allowedOrientations: ['LWH', 'WLH'],
        verification: 'ESTIMATED',
        notes: 'Bruto não informado (usado = líquido). Dimensão de caixa a confirmar.',
      })
    }
  }
  console.log('Seed concluído.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
