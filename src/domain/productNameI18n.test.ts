import { describe, expect, it } from 'vitest'
import { productNameIn } from './productNameI18n'

// um nome real de cada forma ativa no catálogo de produção (29/10/2026): [português, inglês, espanhol]
const VARIANTS: [string, string, string][] = [
    ['Fita de butil 20 × 15 cm', 'Butyl tape 20 × 15 cm', 'Cinta de butilo 20 × 15 cm'],
    ['Fita PE silo-bolsa 41 cm × 5 m transparente', 'PE silo bag tape 41 cm × 5 m clear', 'Cinta PE para silobolsa 41 cm × 5 m transparente'],
    ['Fita PE silo-bolsa 41 cm × 5 m branca', 'PE silo bag tape 41 cm × 5 m white', 'Cinta PE para silobolsa 41 cm × 5 m blanca'],
    ['Kit Hydroforce (mangueira + camlock + torneira)', 'Hydroforce kit (hose + camlock + tap)', 'Kit Hydroforce (manguera + camlock + grifo)'],
    ['Lona padrão 6,5 × 20 m × 500 µm', 'Standard silage cover 6.5 × 20 m × 500 µm', 'Lona estándar 6,5 × 20 m × 500 µm'],
    ['Silo-bolsa 9 pés × 250 pés (76,2 m) × 225 µm', 'Silo bag 9 ft × 250 ft (76.2 m) × 225 µm', 'Silobolsa 9 pies × 250 pies (76,2 m) × 225 µm'],
    ['Silo-bolsa 6,5 pés × 60 m × 160 µm', 'Silo bag 6.5 ft × 60 m × 160 µm', 'Silobolsa 6,5 pies × 60 m × 160 µm'],
    ['Lona padrão Ecobag 10 × 50 m × 90 µm', 'Standard silage cover Ecobag 10 × 50 m × 90 µm', 'Lona estándar Ecobag 10 × 50 m × 90 µm'],
    ['Lona Big Silo 18 × 100 m × 125 µm', 'Silage cover Big Silo 18 × 100 m × 125 µm', 'Lona Big Silo 18 × 100 m × 125 µm'],
    ['Silo-bolsa Ecobag 9 pés × 75 m × 200 µm', 'Silo bag Ecobag 9 ft × 75 m × 200 µm', 'Silobolsa Ecobag 9 pies × 75 m × 200 µm'],
    ['Lona Big Silo Plus X3 24 × 50 m × 125 µm', 'Silage cover Big Silo Plus X3 24 × 50 m × 125 µm', 'Lona Big Silo Plus X3 24 × 50 m × 125 µm'],
    ['Lona BPF Plus X3 10 × 100 m × 125 µm', 'Silage cover BPF Plus X3 10 × 100 m × 125 µm', 'Lona BPF Plus X3 10 × 100 m × 125 µm'],
    ['Lona Plus 18 × 40 m × 120 µm', 'Silage cover Plus 18 × 40 m × 120 µm', 'Lona Plus 18 × 40 m × 120 µm'],
    ['Lona BPF Ecobag 14 × 100 m × 110 µm', 'Silage cover BPF Ecobag 14 × 100 m × 110 µm', 'Lona BPF Ecobag 14 × 100 m × 110 µm'],
    ['Lona BigSafe 4,5 × 50 m × 240 µm', 'Silage cover BigSafe 4.5 × 50 m × 240 µm', 'Lona BigSafe 4,5 × 50 m × 240 µm'],
    ['Silo-bolsa Probag 10 pés × 100 m × 250 µm', 'Silo bag Probag 10 ft × 100 m × 250 µm', 'Silobolsa Probag 10 pies × 100 m × 250 µm'],
    ['Lona padrão 12,19 × 60,96 m (40 × 200 pés) × 127 µm', 'Standard silage cover 12.19 × 60.96 m (40 × 200 ft) × 127 µm', 'Lona estándar 12,19 × 60,96 m (40 × 200 pies) × 127 µm'],
    ['Lona padrão 8 × 50 m × 150 µm (natural)', 'Standard silage cover 8 × 50 m × 150 µm (natural)', 'Lona estándar 8 × 50 m × 150 µm (natural)'],
    ['Lona barreira O2 (PA) 10 × 50 m × 125 µm (poliamida)', 'Silage cover O2 barrier (PA) 10 × 50 m × 125 µm (polyamide)', 'Lona barrera O2 (PA) 10 × 50 m × 125 µm (poliamida)'],
    ['Lona BPF 14 × 100 m × 125 µm', 'Silage cover BPF 14 × 100 m × 125 µm', 'Lona BPF 14 × 100 m × 125 µm'],
    ['Silo-bolsa 6 pés × 56 m × 176 µm (B/P)', 'Silo bag 6 ft × 56 m × 176 µm (W/B)', 'Silobolsa 6 pies × 56 m × 176 µm (B/N)'],
    ['Lona BPF B/P 15 × 50 m × 100 µm', 'Silage cover BPF W/B 15 × 50 m × 100 µm', 'Lona BPF B/N 15 × 50 m × 100 µm'],
    ['Hidroforce 2 × 10 m × 600 µm — 10.000 L', 'Hidroforce 2 × 10 m × 600 µm — 10,000 L', 'Hidroforce 2 × 10 m × 600 µm — 10.000 L'],
    ['Hidrosilo 2 × 30 m × 600 µm — 30.000 L', 'Hidrosilo 2 × 30 m × 600 µm — 30,000 L', 'Hidrosilo 2 × 30 m × 600 µm — 30.000 L'],
    ['Filme BigSafe 8 × 150 m × 50 µm (natural)', 'Film BigSafe 8 × 150 m × 50 µm (natural)', 'Film BigSafe 8 × 150 m × 50 µm (natural)'],
    ['Lona BigSafe Plus X3 18 × 50 m × 125 µm', 'Silage cover BigSafe Plus X3 18 × 50 m × 125 µm', 'Lona BigSafe Plus X3 18 × 50 m × 125 µm'],
    ['Lona BigSafe Ecobag 12 × 50 m × 150 µm', 'Silage cover BigSafe Ecobag 12 × 50 m × 150 µm', 'Lona BigSafe Ecobag 12 × 50 m × 150 µm'],
    ['Filme BPF 5,5 × 60 m × 70 µm', 'Film BPF 5.5 × 60 m × 70 µm', 'Film BPF 5,5 × 60 m × 70 µm'],
    ['Lona BigSafe 8,4 × 75 m × 150 µm (natural)', 'Silage cover BigSafe 8.4 × 75 m × 150 µm (natural)', 'Lona BigSafe 8,4 × 75 m × 150 µm (natural)'],
    ['Bolsa para silagem 2 × 2,5 m × 125 µm — caixa c/15 un', 'Silage bag 2 × 2.5 m × 125 µm — box of 15', 'Bolsa para silaje 2 × 2,5 m × 125 µm — caja c/15 u.'],
    ['Filme BPF 1,04 × 400 m × 120 µm (c/ deslizante)', 'Film BPF 1.04 × 400 m × 120 µm (with slip agent)', 'Film BPF 1,04 × 400 m × 120 µm (con deslizante)'],
    ['Filme BPF 1,4 × 400 m × 18 µm (cilindro gofrado)', 'Film BPF 1.4 × 400 m × 18 µm (embossed roller)', 'Film BPF 1,4 × 400 m × 18 µm (cilindro gofrado)'],
    ['Filme BPF 1,4 × 400 m × 18 µm (cilindro liso)', 'Film BPF 1.4 × 400 m × 18 µm (smooth roller)', 'Film BPF 1,4 × 400 m × 18 µm (cilindro liso)'],
    ['Filme BPF 1,04 × 400 m × 120 µm (s/ deslizante)', 'Film BPF 1.04 × 400 m × 120 µm (without slip agent)', 'Film BPF 1,04 × 400 m × 120 µm (sin deslizante)'],
    ['Filme BigSafe 2,2 × 300 m × 80 µm (transparente)', 'Film BigSafe 2.2 × 300 m × 80 µm (clear)', 'Film BigSafe 2,2 × 300 m × 80 µm (transparente)'],
    ['Lona BigSafe 7,32 × 30,48 m (24 × 100 pés) × 127 µm', 'Silage cover BigSafe 7.32 × 30.48 m (24 × 100 ft) × 127 µm', 'Lona BigSafe 7,32 × 30,48 m (24 × 100 pies) × 127 µm'],
    ['Hidropeso 2,15 × 0,3 m × 500 µm', 'Hidropeso 2.15 × 0.3 m × 500 µm', 'Hidropeso 2,15 × 0,3 m × 500 µm'],
    ['Lona BigFort 8,6 × 40 m × 500 µm', 'Silage cover BigFort 8.6 × 40 m × 500 µm', 'Lona BigFort 8,6 × 40 m × 500 µm'],
    ['Caixa de fitas PE silo-bolsa 41 cm × 5 m branca — c/10 un', 'Box of PE silo bag tapes 41 cm × 5 m white — pack of 10', 'Caja de cintas PE para silobolsa 41 cm × 5 m blanca — c/10 u.'],
    ['Fita PE silo-bolsa 7 cm × 5 m branca s/logo', 'PE silo bag tape 7 cm × 5 m white without logo', 'Cinta PE para silobolsa 7 cm × 5 m blanca sin logo'],
    ['Lona BigSafe 3,2 × 14 m × 500 µm — c/3 un', 'Silage cover BigSafe 3.2 × 14 m × 500 µm — pack of 3', 'Lona BigSafe 3,2 × 14 m × 500 µm — c/3 u.'],
    ['Adesivo de reparo Hidrosilo em PVC 25 × 25 cm', 'Hidrosilo PVC repair patch 25 × 25 cm', 'Adhesivo de reparación Hidrosilo de PVC 25 × 25 cm'],
    ['Caixa de fitas de butil 41 × 35 cm — c/10 un', 'Box of butyl tapes 41 × 35 cm — pack of 10', 'Caja de cintas de butilo 41 × 35 cm — c/10 u.'],
]

// famílias e produtos (cabeçalhos dos grupos e títulos das listas)
const FAMILIES: [string, string, string][] = [
    ['Animal Comfort', 'Animal Comfort', 'Animal Comfort'],
    ['Acessórios', 'Accessories', 'Accesorios'],
    ['Hidroforce', 'Hidroforce', 'Hidroforce'],
    ['Bolsa para silagem', 'Silage bag', 'Bolsa para silaje'],
    ['Hidrosilo', 'Hidrosilo', 'Hidrosilo'],
    ['Silo-bolsa', 'Silo bag', 'Silobolsa'],
    ['Lona de silagem', 'Silage cover', 'Lona de silaje'],
    ['Filmes em rolo', 'Film rolls', 'Film en rollo'],
    ['Hidropeso', 'Hidropeso', 'Hidropeso'],
    ['Lona BPF', 'Silage cover BPF', 'Lona BPF'],
    ['Lona padrão', 'Standard silage cover', 'Lona estándar'],
    ['Lona sem impressão', 'Unprinted silage cover', 'Lona sin impresión'],
    ['Lona BigSafe', 'Silage cover BigSafe', 'Lona BigSafe'],
    ['Lona Big Silo', 'Silage cover Big Silo', 'Lona Big Silo'],
    ['Silo-bolsa Uruguai', 'Silo bag Uruguay', 'Silobolsa Uruguay'],
    ['Lona Plus (LP)', 'Silage cover Plus (LP)', 'Lona Plus (LP)'],
    ['Silo-bolsa sem impressão (exportação)', 'Unprinted silo bag (export)', 'Silobolsa sin impresión (exportación)'],
    ['Silo-bolsa linha Bridon', 'Silo bag Bridon line', 'Silobolsa línea Bridon'],
    ['Lona medida especial', 'Silage cover special size', 'Lona medida especial'],
    ['Silo-bolsa Premium', 'Silo bag Premium', 'Silobolsa Premium'],
    ['Silo-bolsa ADP', 'Silo bag ADP', 'Silobolsa ADP'],
    ['Kit Hydroforce', 'Hydroforce kit', 'Kit Hydroforce'],
    ['Silo-bolsa Ecobag', 'Silo bag Ecobag', 'Silobolsa Ecobag'],
    ['Silo-bolsa Probag', 'Silo bag Probag', 'Silobolsa Probag'],
    ['Techo para ganado', 'Techo para ganado', 'Techo para ganado'],
    ['Silo-bolsa Agromai', 'Silo bag Agromai', 'Silobolsa Agromai'],
    ['Hidroforce Agromai', 'Hidroforce Agromai', 'Hidroforce Agromai'],
    ['Bolsa para silagem Agromai', 'Silage bag Agromai', 'Bolsa para silaje Agromai'],
    ['Fita de butil', 'Butyl tape', 'Cinta de butilo'],
    ['Fita PE silo-bolsa', 'PE silo bag tape', 'Cinta PE para silobolsa'],
    ['Lona BPF Plus X3', 'Silage cover BPF Plus X3', 'Lona BPF Plus X3'],
    ['Lona barreira O2 (PA)', 'Silage cover O2 barrier (PA)', 'Lona barrera O2 (PA)'],
    ['Lona BPF B/P', 'Silage cover BPF W/B', 'Lona BPF B/N'],
    ['Filme BigSafe', 'Film BigSafe', 'Film BigSafe'],
    ['Filme BPF', 'Film BPF', 'Film BPF'],
    ['Adesivo de reparo', 'Repair patch', 'Adhesivo de reparación'],
]

describe('nomes do catálogo no idioma do documento', () => {
  it.each(VARIANTS)('variante: %s', (pt, en, es) => {
    expect(productNameIn(pt, 'en')).toBe(en)
    expect(productNameIn(pt, 'es')).toBe(es)
    expect(productNameIn(pt, 'pt')).toBe(pt)
  })
  it.each(FAMILIES)('família/produto: %s', (pt, en, es) => {
    expect(productNameIn(pt, 'en')).toBe(en)
    expect(productNameIn(pt, 'es')).toBe(es)
  })
  it('termos decididos: Silo bag / Silobolsa, Silage cover / Lona, ft / pies', () => {
    expect(productNameIn('Silo-bolsa 9 pés × 60 m × 210 µm', 'en')).toBe('Silo bag 9 ft × 60 m × 210 µm')
    expect(productNameIn('Silo-bolsa 9 pés × 60 m × 210 µm', 'es')).toBe('Silobolsa 9 pies × 60 m × 210 µm')
    expect(productNameIn('Lona BPF 8 × 50 m × 125 µm', 'en')).toBe('Silage cover BPF 8 × 50 m × 125 µm')
    expect(productNameIn('Lona BPF 8 × 50 m × 125 µm', 'es')).toBe('Lona BPF 8 × 50 m × 125 µm')
  })
  it('rótulos montados do catálogo e números em inglês (decimal com ponto, milhar com vírgula)', () => {
    expect(productNameIn('9 pés', 'en')).toBe('9 ft')
    expect(productNameIn('11,5 pés', 'es')).toBe('11,5 pies')
    expect(productNameIn('Hidrosilo Plus X3 2,15 × 25 m × 600 µm — 20.000 L 4V (filme 4,3 m) — c/15 un', 'en')).toBe('Hidrosilo Plus X3 2.15 × 25 m × 600 µm — 20,000 L 4V (film 4.3 m) — pack of 15')
    expect(productNameIn('Hidrosilo Plus X3 2,15 × 25 m × 600 µm — 20.000 L 4V (filme 4,3 m) — c/15 un', 'es')).toBe('Hidrosilo Plus X3 2,15 × 25 m × 600 µm — 20.000 L 4V (film 4,3 m) — c/15 u.')
  })
  it('números: só o número inteiro, nunca um pedaço; SKU no lugar do nome fica igual', () => {
    expect(productNameIn('Silo-bolsa 9 pés × 99.9744 m × 286 µm', 'en')).toBe('Silo bag 9 ft × 99.9744 m × 286 µm')
    expect(productNameIn('Hidrosilo 2,15m × 25m', 'en')).toBe('Hidrosilo 2.15m × 25m')
    expect(productNameIn('Hidrosilo 2 × 10 m — 1.250,5 L', 'en')).toBe('Hidrosilo 2 × 10 m — 1,250.5 L')
    for (const sku of ['SB-PAC-9X75-210', 'LS-PAC-10X50-125-BPF', 'AC-PAC-2.3X50-240', 'HS-2M-50K', 'KIT-HF', 'SB-BRI-9X99.9744-286'])
      for (const lang of ['en', 'es'] as const) expect(productNameIn(sku, lang)).toBe(sku)
  })
  it('português, vazio e palavras fora do glossário ficam como estão', () => {
    expect(productNameIn('Silo-bolsa 9 pés × 60 m', 'pt')).toBe('Silo-bolsa 9 pés × 60 m')
    expect(productNameIn('', 'en')).toBe('')
    expect(productNameIn(null, 'en')).toBeNull()
    expect(productNameIn(undefined, 'es')).toBeUndefined()
    expect(productNameIn('Techo para ganado', 'en')).toBe('Techo para ganado')
    // palavra que só contém o termo não é trocada ("Lonas" ≠ "Lona", "Plástico" não tem "pés")
    expect(productNameIn('Lonas', 'en')).toBe('Lonas')
    expect(productNameIn('Lonax 2 pésx', 'en')).toBe('Lonax 2 pésx')
  })
})
