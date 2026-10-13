/**
 * Layout das duas planilhas oficiais. Os leitores (src/lib/catalogImport/readSheets.ts) usam estes
 * cabeçalhos para achar as colunas; o motor recebe as linhas já separadas por campo.
 */

/** Normaliza um cabeçalho: sem acentos, minúsculas, espaços colapsados ("Peso líquido" → "peso liquido"). */
export function normHeader(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Planilha de PRODUTOS: cabeçalho na linha 1, colunas achadas pelo texto normalizado. */
export const PRODUCT_SHEET_COLUMNS = {
  code: 'codigo',
  group: 'descricao produto',
  measure: 'medidas',
  thickness: 'espessura',
  brand: 'marca',
  netKg: 'peso liquido',
  grossKg: 'peso bruto',
  ean: 'cod.ean',
} as const
export type ProductSheetField = keyof typeof PRODUCT_SHEET_COLUMNS

/** primeira linha de dados da planilha de produtos */
export const PRODUCT_SHEET_HEADER_ROW = 1

/**
 * TABELA DAS CAIXAS ("CAIXAS PESO E MEDIDAS"): colunas fixas por letra; o cabeçalho da linha 1 só é
 * conferido por palavra-chave (texto normalizado começa com `header`).
 */
export const BOX_SHEET_COLUMNS = {
  code: { col: 'A', header: 'codigo rech' },
  rangeText: { col: 'B', header: 'referencia de peso' },
  reference: { col: 'C', header: 'referencia' },
  palletText: { col: 'D', header: 'pallet' },
  lengthMm: { col: 'E', header: 'comp' },
  widthMm: { col: 'G', header: 'larg' },
  heightMm: { col: 'I', header: 'alt' },
  boxKg: { col: 'K', header: 'peso' },
  kitKg: { col: 'L', header: 'peso kit' },
  plasticKg: { col: 'M', header: 'peso plast' },
  totalKg: { col: 'N', header: 'peso total' },
  boxesPerPalletText: { col: 'O', header: 'distribuicao' },
} as const
export type BoxSheetField = keyof typeof BOX_SHEET_COLUMNS

/** nome da aba da tabela de caixas (senão, a primeira aba) */
export const BOX_SHEET_NAME = 'CAIXAS PESO E MEDIDAS'
