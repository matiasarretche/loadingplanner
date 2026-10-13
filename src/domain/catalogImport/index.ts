/**
 * Motor puro da importação do catálogo oficial (sem banco, sem leitura de arquivo). Ver plan.ts.
 */
export * from './types'
export { DEFAULT_DECISIONS } from './decisions'
export type { BoxReferenceSpec, CodeOverride, LineSpec, SiloBagRule, TarpGroupLine } from './decisions'
export { eanStatusOf, gtinCheckDigit, PACIFIL_GS1_PREFIX } from './ean'
export { BOX_SHEET_COLUMNS, BOX_SHEET_NAME, normHeader, PRODUCT_SHEET_COLUMNS, PRODUCT_SHEET_HEADER_ROW } from './sheetSpec'
export type { BoxSheetField, ProductSheetField } from './sheetSpec'
export { cellDigits, cellNumber, cellText } from './cells'
export { buildImportPlan } from './plan'
