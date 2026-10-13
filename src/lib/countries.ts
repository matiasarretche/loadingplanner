/**
 * País (nome em pt/es/en ou código ISO) → código ISO-3166 alfa-2, para bandeiras e reconhecimento
 * do destino em textos ("… para Uruguay"). Lista dos destinos usuais de exportação da Pacifil.
 */
const NAMES: Record<string, string> = {
  brasil: 'BR', brazil: 'BR',
  uruguai: 'UY', uruguay: 'UY',
  argentina: 'AR',
  paraguai: 'PY', paraguay: 'PY',
  chile: 'CL',
  bolivia: 'BO',
  peru: 'PE',
  equador: 'EC', ecuador: 'EC',
  colombia: 'CO',
  venezuela: 'VE',
  mexico: 'MX',
  guatemala: 'GT',
  honduras: 'HN',
  'el salvador': 'SV', salvador: 'SV',
  nicaragua: 'NI',
  'costa rica': 'CR',
  panama: 'PA',
  cuba: 'CU',
  'republica dominicana': 'DO', 'dominican republic': 'DO',
  'porto rico': 'PR', 'puerto rico': 'PR',
  'estados unidos': 'US', 'united states': 'US', eua: 'US', usa: 'US', eeuu: 'US',
  canada: 'CA',
  espanha: 'ES', espana: 'ES', spain: 'ES',
  portugal: 'PT',
  italia: 'IT', italy: 'IT',
  franca: 'FR', francia: 'FR', france: 'FR',
  alemanha: 'DE', alemania: 'DE', germany: 'DE',
  'reino unido': 'GB', 'united kingdom': 'GB',
  etiopia: 'ET', ethiopia: 'ET',
  'africa do sul': 'ZA', sudafrica: 'ZA', 'south africa': 'ZA',
  angola: 'AO',
  mocambique: 'MZ', mozambique: 'MZ',
  quenia: 'KE', kenia: 'KE', kenya: 'KE',
  nigeria: 'NG',
  egito: 'EG', egipto: 'EG', egypt: 'EG',
  marrocos: 'MA', marruecos: 'MA', morocco: 'MA',
  turquia: 'TR', turkey: 'TR',
  'arabia saudita': 'SA', 'saudi arabia': 'SA',
  'emirados arabes unidos': 'AE', 'emiratos arabes unidos': 'AE', 'united arab emirates': 'AE',
  filipinas: 'PH', philippines: 'PH',
  india: 'IN',
  china: 'CN',
  australia: 'AU',
  'nova zelandia': 'NZ', 'nueva zelanda': 'NZ', 'new zealand': 'NZ',
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

/** Todos os países/territórios habitados (ISO-3166 alfa-2) — para escolher o país em listas. */
export const ALL_COUNTRY_CODES: string[] = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG ' +
  'NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ ' +
  'TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ')

/** nome (pt/es/en, sem acento) → código, para TODOS os países (Intl); montado na primeira consulta */
let byName: Map<string, string> | null = null
function nameIndex(): Map<string, string> {
  if (byName) return byName
  byName = new Map()
  for (const lang of ['pt-BR', 'es', 'en']) {
    let dn: Intl.DisplayNames | null = null
    try {
      dn = new Intl.DisplayNames([lang], { type: 'region' })
    } catch {
      dn = null
    }
    if (!dn) continue
    for (const c of ALL_COUNTRY_CODES) {
      const n = dn.of(c)
      if (n && n !== c && !byName.has(norm(n))) byName.set(norm(n), c)
    }
  }
  return byName
}

/** Código ISO-2 do país (ou null se não reconhecido): código, nomes usuais e o nome de qualquer país em pt/es/en. */
export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null
  const n = norm(name)
  if (/^[a-z]{2}$/.test(n)) return n.toUpperCase()
  return NAMES[n] ?? nameIndex().get(n) ?? null
}

/** Países para listas de escolha: nome em português e código, em ordem alfabética. */
export function countryOptions(exclude: string[] = []): { code: string; name: string }[] {
  return ALL_COUNTRY_CODES.filter((c) => !exclude.includes(c))
    .map((code) => ({ code, name: countryNamePt(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
}

/** URL da bandeira (PNG pequeno) ou null. */
export function flagUrl(name: string | null | undefined): string | null {
  const c = countryCode(name)
  return c ? `https://flagcdn.com/w40/${c.toLowerCase()}.png` : null
}

/** Primeiro país mencionado num texto livre ("monte um 40 HC para Uruguay") — nome como escrito na lista. */
export function countryInText(text: string): string | null {
  const t = ` ${norm(text)} `
  let best: { name: string; at: number } | null = null
  for (const name of Object.keys(NAMES)) {
    const at = t.search(new RegExp(`[^a-z]${name.replace(/ /g, '\\s+')}[^a-z]`))
    if (at >= 0 && name.length > 3 && (!best || at < best.at)) best = { name, at }
  }
  if (!best) return null
  return best.name.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Códigos ISO-2 dos destinos usuais (lista acima), sem repetir. */
export const KNOWN_COUNTRY_CODES: string[] = [...new Set(Object.values(NAMES))]

/** Nome do país em português a partir do código ISO-2 (Intl; sem suporte → o próprio código). */
export function countryNamePt(code: string): string {
  try {
    return new Intl.DisplayNames(['pt-BR'], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/** Nome OFICIAL do país no sistema (português), a partir de qualquer grafia/código; null = não reconhecido. */
export function canonicalCountry(name: string | null | undefined): string | null {
  const c = countryCode(name)
  return c && ALL_COUNTRY_CODES.includes(c) ? countryNamePt(c) : null
}

/** Nome do país no idioma do documento (pt/es/en); não reconhecido → como está. */
export function countryNameIn(name: string | null | undefined, lang: string): string {
  const c = countryCode(name)
  if (!c) return name ?? ''
  try {
    return new Intl.DisplayNames([lang === 'es' ? 'es' : lang === 'en' ? 'en' : 'pt-BR'], { type: 'region' }).of(c) ?? name ?? c
  } catch {
    return name ?? c
  }
}
