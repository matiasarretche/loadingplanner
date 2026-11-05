/**
 * NOMES DO CATÁLOGO NO IDIOMA DO DOCUMENTO (es/en). O catálogo e os snapshots das cargas guardam os nomes em
 * português ("Silo-bolsa 9 pés × 60 m × 210 µm", "Lona BPF 8 × 50 m × 125 µm", "Hidrosilo 2,15 × 25 m × 600 µm —
 * 20.000 L"); os documentos para o cliente em espanhol ou inglês traduzem na hora de emitir. Vale para o nome do
 * produto, o nome da família ("Lona de silagem") e rótulos montados do catálogo ("9 pés").
 *
 * Termos decididos por Matías (05/11/2026): Silo-bolsa = "Silo bag" (en) / "Silobolsa" (es); Lona = "Silage cover"
 * (en) / "Lona" (es); pés = "ft" / "pies". Marcas e linhas (Hidrosilo, Hidroforce, Hidropeso, BigSafe, BPF, Big
 * Silo, BigFort, Ecobag, Probag, Plus X3…) não se traduzem. Palavra que não está no glossário fica como está.
 * Números: em inglês "12,19" → "12.19" e "20.000" → "20,000"; o espanhol escreve como o português.
 * Função pura. A entrada é o texto do catálogo EM PORTUGUÊS (nome do cadastro ou do snapshot da carga).
 */

export type DocLang = 'pt' | 'es' | 'en'

// limites de palavra com acentos (\b do JS não conhece "é" de "pés")
const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const word = (src: string, flags = '') => new RegExp(`${B}${src}${E}`, `gu${flags}`)

type Rule = [RegExp, string | ((...m: string[]) => string)]

/** frases mais longas antes das curtas: "Lona padrão" antes de "Lona", "Caixa de fitas…" antes de "Fita…" */
const PHRASES: Record<'es' | 'en', [string, string][]> = {
  en: [
    ['Adesivo de reparo Hidrosilo em PVC', 'Hidrosilo PVC repair patch'],
    ['Adesivo de reparo', 'Repair patch'],
    ['Caixa de fitas PE silo-bolsa', 'Box of PE silo bag tapes'],
    ['Caixa de fitas de butil', 'Box of butyl tapes'],
    ['Fita PE silo-bolsa', 'PE silo bag tape'],
    ['Fita de butil', 'Butyl tape'],
    ['Bolsa para silagem', 'Silage bag'],
    ['Lona de silagem', 'Silage cover'],
    ['Lona sem impressão', 'Unprinted silage cover'],
    ['Lona padrão', 'Standard silage cover'],
    ['Lona barreira', 'Silage cover barrier'],
    ['Lona', 'Silage cover'],
    ['Silo-bolsa sem impressão', 'Unprinted silo bag'],
    ['Silos-bolsa', 'Silo bags'],
    ['Silo-bolsas', 'Silo bags'],
    ['Silo-bolsa', 'Silo bag'],
    ['silo-bolsas', 'silo bags'],
    ['silo-bolsa', 'silo bag'],
    ['Filmes em rolo', 'Film rolls'],
    ['Filmes', 'Films'],
    ['Filme', 'Film'],
    ['filme', 'film'],
    ['Kit Hydroforce', 'Hydroforce kit'],
    ['Acessórios', 'Accessories'],
    ['mangueira', 'hose'],
    ['torneira', 'tap'],
    ['medida especial', 'special size'],
    ['sem impressão', 'unprinted'],
    ['exportação', 'export'],
    ['padrão', 'standard'],
    ['barreira', 'barrier'],
    ['poliamida', 'polyamide'],
    ['c/ deslizante', 'with slip agent'],
    ['s/ deslizante', 'without slip agent'],
    ['cilindro gofrado', 'embossed roller'],
    ['cilindro liso', 'smooth roller'],
    ['s/logo', 'without logo'],
    ['s/ logo', 'without logo'],
    ['branca', 'white'],
    ['branco', 'white'],
    ['preta', 'black'],
    ['preto', 'black'],
    ['transparente', 'clear'],
    ['média', 'medium'],
    ['B/P', 'W/B'],
    ['Uruguai', 'Uruguay'],
  ],
  es: [
    ['Adesivo de reparo Hidrosilo em PVC', 'Adhesivo de reparación Hidrosilo de PVC'],
    ['Adesivo de reparo', 'Adhesivo de reparación'],
    ['Caixa de fitas PE silo-bolsa', 'Caja de cintas PE para silobolsa'],
    ['Caixa de fitas de butil', 'Caja de cintas de butilo'],
    ['Fita PE silo-bolsa', 'Cinta PE para silobolsa'],
    ['Fita de butil', 'Cinta de butilo'],
    ['Bolsa para silagem', 'Bolsa para silaje'],
    ['Lona de silagem', 'Lona de silaje'],
    ['Lona sem impressão', 'Lona sin impresión'],
    ['Lona padrão', 'Lona estándar'],
    ['Silo-bolsa sem impressão', 'Silobolsa sin impresión'],
    ['Silos-bolsa', 'Silobolsas'],
    ['Silo-bolsas', 'Silobolsas'],
    ['Silo-bolsa', 'Silobolsa'],
    ['silo-bolsas', 'silobolsas'],
    ['silo-bolsa', 'silobolsa'],
    ['Filmes em rolo', 'Film en rollo'],
    ['Filmes', 'Films'],
    ['Filme', 'Film'],
    ['filme', 'film'],
    ['Acessórios', 'Accesorios'],
    ['mangueira', 'manguera'],
    ['torneira', 'canilla'],
    ['sem impressão', 'sin impresión'],
    ['exportação', 'exportación'],
    ['linha', 'línea'],
    ['padrão', 'estándar'],
    ['barreira', 'barrera'],
    ['c/ deslizante', 'con deslizante'],
    ['s/ deslizante', 'sin deslizante'],
    ['s/logo', 'sin logo'],
    ['s/ logo', 'sin logo'],
    ['branca', 'blanca'],
    ['branco', 'blanco'],
    ['preta', 'negra'],
    ['preto', 'negro'],
    ['média', 'media'],
    ['B/P', 'B/N'],
    ['Uruguai', 'Uruguay'],
  ],
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** número escrito em pt-BR ("12,19", "20.000", "1.250,5") → inglês ("12.19", "20,000", "1,250.5") */
const enNumber = (n: string) => n.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'))

const RULES: Record<'es' | 'en', Rule[]> = {
  en: [
    ...PHRASES.en.map(([pt, tr]): Rule => [word(escape(pt)), tr]),
    // "Silage cover barrier O2 (PA)": a barreira vem depois do O2 em inglês fica natural ("O2 barrier")
    [/Silage cover barrier O2/gu, 'Silage cover O2 barrier'],
    // "Silo-bolsa linha Bridon" → "Silo bag Bridon line"
    [word('linha ([\\p{L}\\p{N}]+)'), (_m, l) => `${l} line`],
    [word('linha'), 'line'],
    // "— caixa c/10 un" / "— c/6 un" / "(c/15 un.)"
    [word('caixa c/\\s?(\\d[\\d.]*) un\\.?', 'i'), (_m, n) => `box of ${n}`],
    [word('c/\\s?(\\d[\\d.]*) un\\.?'), (_m, n) => `pack of ${n}`],
    [word('(\\d[\\d.,]*) pés'), (_m, n) => `${n} ft`],
    [word('pés'), 'ft'],
    // números pt-BR → en (milhar com ponto e/ou decimal com vírgula); inteiros simples não mudam
    // (o número inteiro, nunca um pedaço: "99.9744" fica igual; a unidade colada vale: "2,15m" → "2.15m")
    [/(?<![\p{L}\p{N}.,])(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+)(?![\p{N}]|[.,]\d)/gu, (m) => enNumber(m)],
  ],
  es: [
    ...PHRASES.es.map(([pt, tr]): Rule => [word(escape(pt)), tr]),
    [word('caixa c/\\s?(\\d[\\d.]*) un\\.?', 'i'), (_m, n) => `caja c/${n} u.`],
    [word('c/\\s?(\\d[\\d.]*) un\\.?'), (_m, n) => `c/${n} u.`],
    [word('pés'), 'pies'],
  ],
}

/**
 * Nome de produto, de família ou rótulo do catálogo no idioma do documento. Português (ou texto vazio) volta
 * igual. Use em todo texto do catálogo que vai para um documento ao cliente em espanhol ou inglês.
 */
export function productNameIn(text: string, lang: DocLang): string
export function productNameIn(text: string | null | undefined, lang: DocLang): string | null | undefined
export function productNameIn(text: string | null | undefined, lang: DocLang): string | null | undefined {
  if (!text || lang === 'pt') return text
  let out = text
  for (const [re, to] of RULES[lang]) out = out.replace(re, to as (substring: string, ...args: string[]) => string)
  return out
}
