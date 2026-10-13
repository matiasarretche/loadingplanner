/**
 * Etiqueta adesiva de MARCA colada na lateral das caixas (arte real em /public/labels, recortada dos PDFs
 * de produção). No 3D ela aparece numa face lateral, como complemento: a identificação do produto
 * (código/medida) continua impressa nas caixas.
 */
export interface BrandLabel {
  id: string
  title: string
  /** caminho público da imagem (JPEG) */
  src: string
  /** tamanho real do adesivo (mm) */
  wMm: number
  hMm: number
}

const L = (id: string, title: string, wMm: number, hMm: number): BrandLabel => ({ id, title, src: `/labels/${id}.jpg`, wMm, hMm })

export const BRAND_LABELS = {
  hidrosiloPacifil: L('hidrosilo-pacifil', 'Hidrosilo Pacifil (77593)', 300, 150),
  hidroforcePacifil: L('hidroforce-pacifil', 'Hidroforce Pacifil (79739)', 300, 150),
  animalComfort: L('animal-comfort', 'Animal Comfort (79740)', 300, 100),
  silobolsaPacifil: L('silobolsa-pacifil', 'Silo-bolsa Pacifil (77751)', 300, 250),
  silobolsaProbag: L('silobolsa-probag', 'Silo-bolsa Probag (77752)', 300, 250),
  silobolsaEcobag: L('silobolsa-ecobag', 'Silo-bolsa Ecobag (77753)', 300, 250),
  bpfPacifil: L('bpf-pacifil', 'Linha BPF Pacifil (77749)', 300, 90),
  bpfEcobag: L('bpf-ecobag', 'Linha BPF Ecobag (77750)', 300, 90),
  bigsafe: L('bigsafe', 'BigSafe (78160)', 300, 100),
  plusX3: L('plus-x3-uruguai', 'Plus x3 — Uruguai (77770)', 300, 90),
  silobolsaStaal: L('silobolsa-staal', 'Silo-bolsa STAAL (78979)', 300, 250),
  hidrosiloStaal: L('hidrosilo-staal', 'Hidrosilo STAAL (78980)', 300, 150),
  agromaiSilobolsa: L('agromai-silobolsa', 'Agromai Silo-bolsa', 300, 210),
  agromaiBpf: L('agromai-bpf', 'Agromai lona BPF', 240, 100),
  agromaiHidrosilo: L('agromai-hidrosilo', 'Agromai Hidrosilo', 300, 150),
  agromaiHidroforce: L('agromai-hidroforce', 'Agromai Hidroforce', 300, 150),
  silobag: L('silobag', 'SiloBag (AU-IT)', 300, 210),
  loktite: L('loktite', 'Lok Tite Bag', 300, 210),
} satisfies Record<string, BrandLabel>

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()

/**
 * Etiqueta da marca pelo código e nome do produto (os snapshots das cargas guardam os dois).
 * Sem correspondência clara → null (a caixa fica só com a identificação do produto).
 */
export function brandLabelFor(p: { sku: string; name: string }): BrandLabel | null {
  const sku = norm(p.sku)
  // acessórios (ex.: KIT-HF) vão em caixa própria, sem o adesivo do produto principal
  if (/^KIT-/.test(sku)) return null
  const name = norm(p.name)
  const t = `${sku} ${name}`
  const B = BRAND_LABELS
  const isHF = /^HF-/.test(sku) || /\bH[IY]DROFORCE\b/.test(name)
  const isHS = /^HS-/.test(sku) || /\bH[IY]DROSILO\b/.test(name)
  const isSB = /^SB-/.test(sku) || /SILO-?\s?BOLSA/.test(name)
  const isBPF = /-BPF$/.test(sku) || /\bBPF\b/.test(name)
  // bolsas para silagem: sem adesivo cadastrado (o da Agromai é de lona para silo)
  if (/^BS-/.test(sku) || /BOLSA PARA SILAGEM/.test(name)) return null
  // marcas de clientes (private label)
  if (/AGROMAI/.test(t)) return isHF ? B.agromaiHidroforce : isHS ? B.agromaiHidrosilo : isSB ? B.agromaiSilobolsa : B.agromaiBpf
  if (/\bSTAAL\b/.test(t)) return isHS ? B.hidrosiloStaal : isSB ? B.silobolsaStaal : null
  if (/LOK\s?TITE/.test(t)) return B.loktite
  if (/\bSILO\s?BAG\b/.test(name)) return B.silobag
  // linhas Pacifil e marcas próprias
  if (isHF) return B.hidroforcePacifil
  if (isHS) return B.hidrosiloPacifil
  if (/^AC-/.test(sku) || /ANIMAL COMFORT|TECHO PARA GANADO/.test(name)) return B.animalComfort
  if (/^SB-PRO-/.test(sku) || /PROBAG/.test(name)) return B.silobolsaProbag
  if (/^SB-ECO-/.test(sku) || /ECOBAG/.test(t)) return isBPF ? B.bpfEcobag : B.silobolsaEcobag
  if (/BIG\s?SAFE/.test(name)) return B.bigsafe
  if (isBPF) return B.bpfPacifil
  // silo-bolsa sem marca no código/nome = Pacifil (regra de marca do sistema); ADP e Bridon não têm adesivo cadastrado
  if (isSB && !/^SB-(ADP|BRI)-/.test(sku) && !/\b(ADP|BRIDON|BRYDON)\b/.test(name)) return B.silobolsaPacifil
  return null
}
