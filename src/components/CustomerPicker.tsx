'use client'

import { customerLabel, customerLabelParts, customerSearch, type CustomerSearchFields } from '@/domain/customerAddress'
import type { PickerGroup } from './customerPickerList'
import { SearchPicker } from './SearchPicker'

export interface PickerCustomer extends CustomerSearchFields {
  id: number
}

/**
 * Cliente da carga com BUSCA: digita parte da razão social, da cidade, do país ou o código do ERP e a
 * lista filtra ("Razão social — Cidade, País · cód. 609"). A primeira opção é sempre "— novo cliente —"
 * (valor null). Teclado: ↑/↓ escolhe, Enter confirma, Esc fecha. Com `name`, envia o id num campo oculto
 * (vazio = novo cliente). `featured`: grupos mostrados no topo antes de digitar (ex.: homônimos e parecidos
 * com o do pedido), cada um com o seu título. `onChange` só é chamado quando o cliente MUDA.
 * (Comportamento e acessibilidade: SearchPicker.)
 */
export function CustomerPicker({
  customers,
  value,
  onChange,
  name,
  featured,
  inputStyle,
  disabled,
  newLabel = '— novo cliente —',
}: {
  customers: PickerCustomer[]
  value: number | null
  onChange: (id: number | null) => void
  name?: string
  featured?: PickerGroup[]
  inputStyle?: React.CSSProperties
  disabled?: boolean
  newLabel?: string
}) {
  return (
    <SearchPicker
      idPrefix="clientes"
      items={customers}
      value={value}
      onChange={onChange}
      name={name}
      featured={featured}
      inputStyle={inputStyle}
      disabled={disabled}
      searchFactory={customerSearch}
      labelParts={customerLabelParts}
      label={customerLabel}
      texts={{
        emptyLabel: newLabel,
        searchPlaceholder: 'buscar: nome, cidade, país ou código',
        closedPlaceholder: `${newLabel} · clique para buscar nome, cidade ou código`,
        clearLabel: 'Limpar cliente',
        clearTitle: `Limpar (volta para “${newLabel}”)`,
        listLabel: 'Clientes',
        restLabel: 'Cadastrados',
        restLabelAlone: 'Clientes cadastrados',
        noResults: (q) => `Nenhum cliente com “${q}”. Use “${newLabel}” para cadastrar.`,
        more: (n) => `+ ${n} clientes — continue digitando para filtrar`,
        found: (n) => (n === 1 ? '1 cliente encontrado. ' : `${n} clientes encontrados. `),
      }}
    />
  )
}
