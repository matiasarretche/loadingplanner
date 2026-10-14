/**
 * DECISÕES DO DONO (Matías, 13/10/2026) para importar o catálogo oficial. Tudo que é escolha de negócio
 * fica aqui, como configuração: o motor (plan.ts e vizinhos) só aplica. Mudar uma decisão = mudar um valor.
 */
import type { BoxLine, BoxMeasure, FamilyKey, LineKey } from './types'

export interface LineSpec {
  family: FamilyKey
  /** linha do produto no catálogo (tabela product: nome) */
  productLine: string
  /** começo do nome do produto ("Lona BPF", "Silo-bolsa Ecobag"…) */
  namePrefix: string
  /** linhas da tabela de caixas que valem para este produto (regra explícita) */
  boxLines: BoxLine[]
  /** linhas irmãs: só quando a própria linha não tem fila para a medida */
  secondaryBoxLines: BoxLine[]
}

export interface BoxReferenceSpec {
  family: 'SILO_BAG' | 'SILAGE_TARP' | 'HIDROSILO'
  line: BoxLine
  measures: BoxMeasure[]
  thicknessUm?: number[]
  /** faixa de peso da fila não vale (BigSafe / Big Silo: "ATÉ 55KG" não corresponde a estas lonas) */
  ignoreWeightRange?: boolean
  note?: string
}

export interface SiloBagRule {
  box: string
  line: LineKey
  diametersFt: number[]
  lengthM: number
  lenTolM: number
  minNetKg: number
  maxNetKg: number
  reason: string
}

export interface CodeOverride {
  /** caixa atribuída (código da tabela de caixas) */
  box?: string
  confidence?: 'HIGH' | 'MEDIUM'
  reason?: string
  /** só a sugestão do pendente */
  suggestion?: string
}

export type TarpGroupLine = {
  'SILO PLAS/RESERV BPF': LineKey
  'SILO PLAS/RESERV BPF PLUS': LineKey
  /** nomes "BPF …" no grupo SILO PLASTICO/RESERV (a outra série das lonas do grupo BPF: mesmo peso, outro formato) */
  namedBpfPrefix: LineKey
  /** lona sem linha no nome (grupo SBG com medida em metros) */
  otherPlain: LineKey
  /** grupo PROTECAO PLAST MULTICAMADAS (BigSafe) */
  multilayer: LineKey
}

/** Produto FORA da planilha oficial, criado por decisão: lido pelo mesmo motor (nome, linha, caixa, bruto). */
export interface ExtraProduct {
  /** SKU do produto (não é um código da fábrica) */
  sku: string
  /** grupo, medida, espessura e marca escritos como na planilha */
  group: string
  measure: string
  thickness: string
  brand: string
  /** peso líquido estimado: escolhe a caixa e a tara; com perímetro real cadastrado o gravado é o calculado */
  netKg: number
  /** origem do peso / do pedido: vai para as observações do cadastro (sem perímetro real) */
  note: string
  /** origem do pedido, sem o peso: começo da observação quando o peso vem do perímetro real */
  origin?: string
}

export interface ImportDecisions {
  id: string
  /** marca da planilha (coluna E, maiúsculas) → marca do catálogo */
  brandMap: Record<string, string>
  /** SKUs atuais que continuam ativos mesmo fora da planilha */
  keepActiveSkus: string[]
  /**
   * siglas de ESPESSURA da fábrica no silo-bolsa ("BPT 9PESX60M"): só repetem a espessura, que já está na medida —
   * ficam fora do nome e da comparação de repetidos (o mesmo silo-bolsa com e sem a sigla = repetido)
   */
  siloBagThicknessCodes: string[]
  /** a mesma informação escrita na espessura ("220 MICRAS / MEDIA") */
  siloBagThicknessTags: string[]
  /** produtos que não estão na planilha e entram na importação (o SKU dado é o código) */
  extraProducts: ExtraProduct[]
  /** acompanhantes obrigatórios por família (atributos acessorio_sku / acessorio_qtd) */
  companionRules: { family: FamilyKey; sku: string; qty: number }[]
  families: Record<FamilyKey, { code: string; name: string }>
  /** famílias criadas se não existirem, nesta ordem (sort = máx. + 1, + 2…) */
  newFamilies: FamilyKey[]
  lines: Record<LineKey, LineSpec>
  tarpGroupLine: TarpGroupLine
  /** lona até esta espessura (µm) é filme em rolo */
  thinFilmMaxUm: number
  /** grupo da planilha que é sempre filme em rolo */
  filmGroup: string
  /** texto do palete na tabela de caixas → código do tipo de palete do programa */
  palletTextToCode: Record<string, string>
  /** "20 ou 26" caixas por palete: o maior número */
  boxesPerPalletChoice: 'MAX' | 'MIN'
  /**
   * o palete do catálogo prevalece nos produtos que já existem — desde que sirva para a caixa planejada
   * (mesmas caixas por camada, até 2.292 mm de altura); senão vale o da tabela de caixas (ver pallet.ts)
   */
  palletPrevalence: 'CATALOG_ALWAYS' | 'CATALOG_SAME_BOX'
  /** medidas corrigidas por código de caixa (aplicadas depois de comprimento ≥ largura) */
  boxDimOverrides: Record<string, { lengthMm?: number; widthMm?: number; heightMm?: number }>
  /** tara da caixa: soma K+L+M (a coluna N às vezes é digitada) */
  boxTare: 'COMPONENTS' | 'SHEET_TOTAL'
  /** interpretação de cada fila da tabela de caixas, pela referência (coluna C normalizada) */
  boxReferenceSpecs: Record<string, BoxReferenceSpec>
  /** filas BigSafe / Big Silo: só para estas lonas */
  bigTarpRule: { minWidthM: number; maxWidthM: number; maxLengthM: number; maxThicknessUm: number }
  /** Hidrosilo 2 m × 600 µm mais pesado de cada caixa (kg) — teto de peso da caixa */
  hsDesignatedMaxKg: Record<string, number>
  siloBagRules: SiloBagRule[]
  /** silo-bolsa entre estes pesos: a tabela não tem caixa → pendente com sugestão */
  siloBagGap: { aboveKg: number; belowKg: number; suggestion: string }
  hidrosilo3m: 'KEEP_CURRENT_BOX_UNLESS_SHEET_ROW'
  weightTolKg: number
  weightTolPct: number
  tareMatchTolKg: number
  matchThicknessTolPct: number
  matchNetTolPct: number
  grossRule: { absurdFactor: number; absurdMinTareKg: number; maxTareKg: number; maxTarePct: number }
  /** pesos líquidos provisórios do catálogo atual (máximo da faixa da tabela de caixas) */
  placeholderNets: number[]
  codeOverrides: Record<string, CodeOverride>
}

const FT = 0.3048
const r3 = (x: number) => Math.round(x * 1000) / 1000
const sb = (d: number, lenM: number | null, lenFt?: number): BoxMeasure => ({ d, lenM: lenM ?? (lenFt ? r3(lenFt * FT) : null), lenFt: lenFt ?? null })
const lt = (w: number, lenM: number): BoxMeasure => ({ w, lenM })
const hs = (capacityL: number, lenM?: number): BoxMeasure => ({ capacityL, lenM: lenM ?? null })

const BIG: BoxLine[] = ['BIGSAFE']
const BIGSILO: BoxLine[] = ['BIGSILO']

export const DEFAULT_DECISIONS: ImportDecisions = {
  id: '2026-10-14b-matias',
  brandMap: { PACIFIL: 'Pacifil', ECOBAG: 'Ecobag', PROBAG: 'Probag', FITA: 'Pacifil', 'EXT. B': 'Pacifil' },
  // 14/10/2026 (lista de silo-bolsas Venezuela / representante Flavinho): os 6 pés × 75 e × 100 m × 180 µm não estão
  // na planilha — continuam ativos com o peso e a caixa atuais até o Matías passar o código da fábrica
  keepActiveSkus: ['KIT-HF', 'SB-PAC-6X75-180', 'SB-PAC-6X100-180'],
  // 14/10/2026 (Matías): BPT e BBT = bolsa tradicional (a mais grossa da medida), BPM = média; sem sigla = fina.
  // Como a espessura já está na medida, a sigla sai do nome e o mesmo silo-bolsa com e sem ela é repetido (decisão 10)
  siloBagThicknessCodes: ['BPT', 'BBT', 'BPM'],
  siloBagThicknessTags: ['MEDIA'],
  // 14/10/2026 (mesma lista): 10 pés × 100 m e × 60 m × 235 µm não existem na planilha. Peso líquido ESTIMADO a
  // 2,132 kg/m, o mesmo do 19528 (10 × 75 m × 235 µm = 159,9 kg) e do 19530 (10 × 90 m × 235 µm = 191,9 kg).
  // Com o perímetro real do 10 pés cadastrado (9,65 m), o peso gravado é o calculado (211,35 / 126,81 kg)
  extraProducts: [
    { sku: 'SB-PAC-10X100-235', group: 'SILO PLAS/RESERV SBG', measure: '10PESX100M', thickness: '235MIC', brand: 'PACIFIL', netKg: 213.2, origin: 'fora da planilha oficial (pedido do Matías, 14/10/2026)', note: 'fora da planilha oficial (pedido do Matías, 14/10/2026): peso líquido ESTIMADO 213,2 kg = 2,132 kg/m (19528 / 19530) — confirmar o peso real' },
    { sku: 'SB-PAC-10X60-235', group: 'SILO PLAS/RESERV SBG', measure: '10PESX60M', thickness: '235MIC', brand: 'PACIFIL', netKg: 127.9, origin: 'fora da planilha oficial (pedido do Matías, 14/10/2026)', note: 'fora da planilha oficial (pedido do Matías, 14/10/2026): peso líquido ESTIMADO 127,9 kg = 2,132 kg/m (19528 / 19530) — confirmar o peso real' },
  ],
  companionRules: [{ family: 'HYDROFORCE', sku: 'KIT-HF', qty: 1 }],
  families: {
    SILO_BAG: { code: 'SILO_BAG', name: 'Silo-bolsa' },
    SILAGE_TARP: { code: 'SILAGE_TARP', name: 'Lona de silagem' },
    HIDROSILO: { code: 'HIDROSILO', name: 'Hidrosilo' },
    HYDROFORCE: { code: 'HYDROFORCE', name: 'Hidroforce' },
    SILAGE_BAG: { code: 'SILAGE_BAG', name: 'Bolsa para silagem' },
    ACCESSORY: { code: 'ACCESSORY', name: 'Acessórios' },
    FILM_ROLL: { code: 'FILM_ROLL', name: 'Filmes em rolo' },
    HIDROPESO: { code: 'HIDROPESO', name: 'Hidropeso' },
  },
  newFamilies: ['FILM_ROLL', 'HIDROPESO'],
  lines: {
    SB_STD: { family: 'SILO_BAG', productLine: 'Silo-bolsa', namePrefix: 'Silo-bolsa', boxLines: ['STD'], secondaryBoxLines: [] },
    SB_ECO: { family: 'SILO_BAG', productLine: 'Silo-bolsa Ecobag', namePrefix: 'Silo-bolsa Ecobag', boxLines: ['ECO'], secondaryBoxLines: ['STD'] },
    SB_PRO: { family: 'SILO_BAG', productLine: 'Silo-bolsa Probag', namePrefix: 'Silo-bolsa Probag', boxLines: ['PRO'], secondaryBoxLines: ['STD'] },
    TARP_BPF: { family: 'SILAGE_TARP', productLine: 'Lona BPF', namePrefix: 'Lona BPF', boxLines: ['BPF'], secondaryBoxLines: ['STD', 'LP'] },
    TARP_STD: { family: 'SILAGE_TARP', productLine: 'Lona padrão', namePrefix: 'Lona padrão', boxLines: ['STD'], secondaryBoxLines: ['BPF', 'LP'] },
    TARP_PLUS: { family: 'SILAGE_TARP', productLine: 'Lona Plus (LP)', namePrefix: 'Lona Plus', boxLines: ['LP'], secondaryBoxLines: ['BPF', 'STD'] },
    TARP_BPF_PLUSX3: { family: 'SILAGE_TARP', productLine: 'Lona BPF Plus X3', namePrefix: 'Lona BPF Plus X3', boxLines: ['BPF'], secondaryBoxLines: ['STD', 'LP'] },
    TARP_BPF_BP: { family: 'SILAGE_TARP', productLine: 'Lona BPF B/P', namePrefix: 'Lona BPF B/P', boxLines: ['BPF'], secondaryBoxLines: ['STD', 'LP'] },
    TARP_BARRIER_PA: { family: 'SILAGE_TARP', productLine: 'Lona barreira O2 (PA)', namePrefix: 'Lona barreira O2 (PA)', boxLines: [], secondaryBoxLines: ['BPF', 'STD'] },
    TARP_BIGSAFE: { family: 'SILAGE_TARP', productLine: 'Lona BigSafe', namePrefix: 'Lona BigSafe', boxLines: BIG, secondaryBoxLines: BIGSILO },
    TARP_BIGSAFE_PLUSX3: { family: 'SILAGE_TARP', productLine: 'Lona BigSafe', namePrefix: 'Lona BigSafe Plus X3', boxLines: BIG, secondaryBoxLines: BIGSILO },
    TARP_BIGFORT: { family: 'SILAGE_TARP', productLine: 'Lona BigSafe', namePrefix: 'Lona BigFort', boxLines: BIG, secondaryBoxLines: BIGSILO },
    TARP_BIGSILO: { family: 'SILAGE_TARP', productLine: 'Lona Big Silo', namePrefix: 'Lona Big Silo', boxLines: BIGSILO, secondaryBoxLines: BIG },
    TARP_BIGSILO_PLUSX3: { family: 'SILAGE_TARP', productLine: 'Lona Big Silo', namePrefix: 'Lona Big Silo Plus X3', boxLines: BIGSILO, secondaryBoxLines: BIG },
    FILM_BPF: { family: 'FILM_ROLL', productLine: 'Filme BPF', namePrefix: 'Filme BPF', boxLines: [], secondaryBoxLines: [] },
    FILM_BIGSAFE: { family: 'FILM_ROLL', productLine: 'Filme BigSafe', namePrefix: 'Filme BigSafe', boxLines: [], secondaryBoxLines: [] },
    HS: { family: 'HIDROSILO', productLine: 'Hidrosilo', namePrefix: 'Hidrosilo', boxLines: ['HS'], secondaryBoxLines: [] },
    HS_PLUSX3: { family: 'HIDROSILO', productLine: 'Hidrosilo', namePrefix: 'Hidrosilo Plus X3', boxLines: ['HS'], secondaryBoxLines: [] },
    HF: { family: 'HYDROFORCE', productLine: 'Hidroforce', namePrefix: 'Hidroforce', boxLines: ['HS'], secondaryBoxLines: [] },
    SILAGE_BAG: { family: 'SILAGE_BAG', productLine: 'Bolsa para silagem', namePrefix: 'Bolsa para silagem', boxLines: [], secondaryBoxLines: [] },
    HIDROPESO: { family: 'HIDROPESO', productLine: 'Hidropeso', namePrefix: 'Hidropeso', boxLines: [], secondaryBoxLines: [] },
    TAPE_PE: { family: 'ACCESSORY', productLine: 'Fita PE silo-bolsa', namePrefix: 'Fita PE silo-bolsa', boxLines: [], secondaryBoxLines: [] },
    TAPE_BUTYL: { family: 'ACCESSORY', productLine: 'Fita de butil', namePrefix: 'Fita de butil', boxLines: [], secondaryBoxLines: [] },
    PATCH: { family: 'ACCESSORY', productLine: 'Adesivo de reparo', namePrefix: 'Adesivo de reparo Hidrosilo em PVC', boxLines: [], secondaryBoxLines: [] },
  },
  // decisão 4 (confirmada pelo Matías em 14/10/2026 com o exemplo 19675 "8MX50M"): o grupo "SILO PLAS/RESERV BPF"
  // é a Lona padrão de EXPORTAÇÃO; os nomes "BPF 8X50…" do grupo SILO PLASTICO/RESERV são a outra série (mesmo
  // peso, só muda o formato: aberta × tubular) = Lona BPF, mercado interno. As duas séries nunca podem cair na
  // mesma linha (a exportação ficaria sem Lona padrão: ver o bloqueio LONA_RULE_EXPORT em plan.ts).
  tarpGroupLine: { 'SILO PLAS/RESERV BPF': 'TARP_STD', 'SILO PLAS/RESERV BPF PLUS': 'TARP_PLUS', namedBpfPrefix: 'TARP_BPF', otherPlain: 'TARP_STD', multilayer: 'TARP_BIGSAFE' },
  thinFilmMaxUm: 80,
  filmGroup: 'SILO PLAS/RESERV',
  // decisão 12: o "2,00X1,20" da planilha é o palete doble que o programa já usa
  palletTextToCode: { '1,00X1,20': 'PBR-1', '1,15X1,15': 'PCF-1150', '1,10X1,30': 'PCF-1100x1300', '2,30X1,15': 'PCF-1150-DUPLO', '2,00X1,20': 'PCF-1150-DUPLO' },
  boxesPerPalletChoice: 'MAX',
  palletPrevalence: 'CATALOG_ALWAYS',
  // decisão 15: Hidrosilo 50 m com 380 mm de largura (3 × 385 não cabe no palete de 1150)
  boxDimOverrides: { '77290': { widthMm: 380 } },
  boxTare: 'COMPONENTS',
  boxReferenceSpecs: {
    'BPF 6X25-8X25': { family: 'SILAGE_TARP', line: 'BPF', measures: [lt(6, 25), lt(8, 25)] },
    '6X25-8X25': { family: 'SILAGE_TARP', line: 'STD', measures: [lt(6, 25), lt(8, 25)], note: 'Sem linha na referência: lona padrão (a fila de cima é a BPF).' },
    'BPF 4X100, 8X50': { family: 'SILAGE_TARP', line: 'BPF', measures: [lt(4, 100), lt(8, 50)] },
    '6 X 50 / 8 X 5O / 4X100': { family: 'SILAGE_TARP', line: 'STD', measures: [lt(6, 50), lt(8, 50), lt(4, 100)], note: 'A planilha escreve "8 X 5O" (letra O): lido como 8×50.' },
    '6 X 50 / 8 X 5O / 4X100 SEM IMPRESSAO': { family: 'SILAGE_TARP', line: 'SI', measures: [lt(6, 50), lt(8, 50), lt(4, 100)] },
    'BIGSAFE 16-18-20X50 COMPRIMENTO 1,60MTS': { family: 'SILAGE_TARP', line: 'BIGSAFE', measures: [lt(16, 50), lt(18, 50), lt(20, 50)], ignoreWeightRange: true, note: 'Caixa de 1,60 m; a faixa "ATÉ 55KG" não corresponde a estas lonas (89–117 kg).' },
    '8X100/ 10X50 / 12X50 / 14X50': { family: 'SILAGE_TARP', line: 'STD', measures: [lt(8, 100), lt(10, 50), lt(12, 50), lt(14, 50)] },
    'BIG SILO 22-24-28X50 COMPRIMENTO 2,10 MTS': { family: 'SILAGE_TARP', line: 'BIGSILO', measures: [lt(22, 50), lt(24, 50), lt(28, 50)], ignoreWeightRange: true, note: 'Caixa de 2,10 m; a faixa "ATÉ 55KG" não corresponde a estas lonas.' },
    '5 E 6 PES': { family: 'SILO_BAG', line: 'STD', measures: [sb(5, null), sb(6, null)], note: '"5 E 6 PÉS": só o diâmetro; qualquer comprimento dentro da faixa de peso.' },
    '6 PES URUGUAI': { family: 'SILO_BAG', line: 'URU', measures: [sb(6, null)], note: 'Fila oculta, sem código de caixa (Uruguai 6 pés).' },
    'BPF 10X50/6X100/8X100/12X50/14X50': { family: 'SILAGE_TARP', line: 'BPF', measures: [lt(10, 50), lt(6, 100), lt(8, 100), lt(12, 50), lt(14, 50)] },
    '6X100 S/ IMPRESSAO': { family: 'SILAGE_TARP', line: 'SI', measures: [lt(6, 100)] },
    'LP 14X50': { family: 'SILAGE_TARP', line: 'LP', measures: [lt(14, 50)] },
    '9 PES': { family: 'SILO_BAG', line: 'STD', measures: [sb(9, null)], note: '"9 PÉS": só o diâmetro (na prática 9×60, faixa 100–125 kg).' },
    '10X100': { family: 'SILO_BAG', line: 'STD', measures: [sb(10, 100)], note: 'Mesmo código 74041 da fila "9X60 PRÓ BAG" (tara 5,9 × 5,56 kg).' },
    '9X60 ECO BAG': { family: 'SILO_BAG', line: 'ECO', measures: [sb(9, 60)] },
    '9X60 PRO BAG': { family: 'SILO_BAG', line: 'PRO', measures: [sb(9, 60)], note: 'Mesmo código 74041 da fila "10X100".' },
    '9X200/60 SEM IMPRESSAO EXPORTACAO': { family: 'SILO_BAG', line: 'SI', measures: [sb(9, 60, 200)] },
    '9X75': { family: 'SILO_BAG', line: 'STD', measures: [sb(9, 75)] },
    '9X75 ECO BAG': { family: 'SILO_BAG', line: 'ECO', measures: [sb(9, 75)] },
    '9X75 PRO BAG': { family: 'SILO_BAG', line: 'PRO', measures: [sb(9, 75)] },
    '9X250/75 SEM IMPRESSAO': { family: 'SILO_BAG', line: 'SI', measures: [sb(9, 75, 250)] },
    '10X75': { family: 'SILO_BAG', line: 'STD', measures: [sb(10, 75)] },
    '9X100 PRO BAG': { family: 'SILO_BAG', line: 'PRO', measures: [sb(9, 100)] },
    '10X250/75 SEM IMPRESSAO': { family: 'SILO_BAG', line: 'SI', measures: [sb(10, 75, 250)] },
    '10X250/75 LINHA BRIDON': { family: 'SILO_BAG', line: 'BRIDON', measures: [sb(10, 75, 250)], note: 'Mesmo código 76574 da fila sem impressão.' },
    '12X75': { family: 'SILO_BAG', line: 'STD', measures: [sb(12, 75)] },
    '9X100 ECO BAG': { family: 'SILO_BAG', line: 'ECO', measures: [sb(9, 100)] },
    '9X125 PRO BAG': { family: 'SILO_BAG', line: 'PRO', measures: [sb(9, 125)] },
    '12X250 / 9X100 SEM IMPRESSAO': { family: 'SILO_BAG', line: 'SI', measures: [sb(12, null, 250), sb(9, 100)] },
    '9X300 / 9X328 / 11,5X200 / 11,5X250 / 12X200 / 12X250/ 10X300 BRIDON': {
      family: 'SILO_BAG',
      line: 'BRIDON',
      measures: [sb(9, null, 300), sb(9, null, 328), sb(11.5, null, 200), sb(11.5, null, 250), sb(12, null, 200), sb(12, null, 250), sb(10, null, 300)],
      note: 'Comprimentos em pés.',
    },
    '9X125': { family: 'SILO_BAG', line: 'STD', measures: [sb(9, 125)] },
    '10X400': { family: 'SILO_BAG', line: 'STD', measures: [sb(10, null, 400)], note: '"10X400": 10 pés × 400 pés (≈122 m).' },
    '10 X 400 / 10X500 LINHA BRIDON': { family: 'SILO_BAG', line: 'BRIDON', measures: [sb(10, null, 400), sb(10, null, 500)] },
    '12X500': { family: 'SILO_BAG', line: 'STD', measures: [sb(12, null, 500)], note: '"12X500": 12 pés × 500 pés (≈152 m).' },
    '12 X 500 / 11,5X500 SEM IMPRESSAO': { family: 'SILO_BAG', line: 'SI', measures: [sb(12, null, 500), sb(11.5, null, 500)] },
    '12 X 500 / 11,5X500 BRIDON': { family: 'SILO_BAG', line: 'BRIDON', measures: [sb(12, null, 500), sb(11.5, null, 500)] },
    '18X40 /18 X 50 120 MICRAS/150 MICRAS': { family: 'SILAGE_TARP', line: 'ESP', measures: [lt(18, 40), lt(18, 50)], thicknessUm: [120, 150], note: 'Medida especial: 120 ou 150 µm.' },
    '15X46-EUA': { family: 'SILAGE_TARP', line: 'ESP-EUA', measures: [lt(15, 46)], note: 'Medida dos EUA (50 × 150 pés).' },
    'HIDRO SILO- 5/10 MTS': { family: 'HIDROSILO', line: 'HS-OLD', measures: [hs(5000, 5), hs(10000, 10)], note: 'Tabela ANTIGA de Hidrosilo (só para conferir taras).' },
    'HIDRO SILO- 15/20 MTS': { family: 'HIDROSILO', line: 'HS-OLD', measures: [hs(15000, 15), hs(20000, 20)], note: 'Tabela ANTIGA de Hidrosilo.' },
    'HIDRO SILO- 25/30/35MTS': { family: 'HIDROSILO', line: 'HS-OLD', measures: [hs(25000, 25), hs(30000, 30), hs(35000, 35)], note: 'Tabela ANTIGA de Hidrosilo.' },
    'HIDRO SILO- 40/50 MTS': { family: 'HIDROSILO', line: 'HS-OLD', measures: [hs(40000, 40), hs(50000, 50)], note: 'Tabela ANTIGA de Hidrosilo.' },
    'HIDROSILO 500, 1.000 E 2.000 LITROS': { family: 'HIDROSILO', line: 'HS', measures: [hs(500), hs(1000), hs(2000)], note: 'Mesmo código 72786 da lona BPF 6×25/8×25 (outra tara e outro palete).' },
    'HIDROSILO 5,5 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(5000, 5.5)] },
    'HIDROSILO 10 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(10000, 10)] },
    'HIDROSILO 15 MTS E 20 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(15000, 15), hs(20000, 20)] },
    'HIDROSILO 25 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(25000, 25)] },
    'HIDROSILO 30 E 40 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(30000, 30), hs(40000, 40)] },
    'HIDROSILO 50 MTS': { family: 'HIDROSILO', line: 'HS', measures: [hs(50000, 50)], note: 'A planilha diz 385 mm de largura; vale 380 (decisão de 13/10/2026).' },
  },
  bigTarpRule: { minWidthM: 16, maxWidthM: 28, maxLengthM: 50.5, maxThicknessUm: 125 },
  hsDesignatedMaxKg: { '72786': 6.71, '79581': 12.3, '79582': 22.37, '79583': 44.74, '77288': 55.92, '77289': 89.47, '77290': 111.84 },
  // decisão 14: silo-bolsa Pacifil 9/10 × 100 m na mesma caixa do Probag
  siloBagRules: [
    {
      box: '74043',
      line: 'SB_STD',
      diametersFt: [9, 10],
      lengthM: 100,
      lenTolM: 1.5,
      minNetKg: 126,
      maxNetKg: 230,
      reason: 'Silo-bolsa Pacifil 9/10 × 100 m: mesma caixa do Probag (74043) — decisão de 13/10/2026',
    },
  ],
  siloBagGap: { aboveKg: 60, belowKg: 100, suggestion: '69488' },
  hidrosilo3m: 'KEEP_CURRENT_BOX_UNLESS_SHEET_ROW',
  weightTolKg: 1,
  weightTolPct: 0.02,
  tareMatchTolKg: 0.02,
  matchThicknessTolPct: 0.02,
  matchNetTolPct: 0.02,
  grossRule: { absurdFactor: 3, absurdMinTareKg: 5, maxTareKg: 20, maxTarePct: 0.25 },
  placeholderNets: [30, 50, 55, 60, 79, 100, 125, 147, 175, 230, 260, 340, 450],
  // correções da verificação (proposta, seção V.2)
  codeOverrides: {
    '14413': { box: '70328', confidence: 'MEDIUM', reason: 'BPF 8×100 de 89,5 kg: só cabe na faixa 80–100 kg (caixa 70328) — verificação V.2.5' },
    '19672': { suggestion: '70328' },
    '19659': { suggestion: '70328' },
    '19658': { suggestion: '70328' },
    '17367': { suggestion: '70328' },
    '17137': { box: '70328', confidence: 'MEDIUM', reason: 'Lona de 81,6 kg: caixa 70328 (80–100 kg) — verificação V.2.4' },
  },
}
