'use client'

import { useMemo, useState } from 'react'
import { customerSearch } from '@/domain/customerAddress'
import { SPECIAL_TRANSPORT_LABEL, specialTransportCompany, transportCompanyLabel } from '@/domain/transportCompany'
import { SearchPicker } from './SearchPicker'

export interface PickerTransportCompany {
  id: number
  code: string
  name: string
  active: boolean
}

/**
 * busca: código exato do ERP primeiro, depois o nome que começa com o texto, a palavra do nome e o resto; as
 * situações especiais também pelo nome da situação ("retirada", "correios", "próprio")
 */
const searchFactory = (list: PickerTransportCompany[]) => {
  const byId = new Map(list.map((c) => [c.id, c]))
  const find = customerSearch(list.map((c) => {
    const sp = specialTransportCompany(c)
    return { id: c.id, name: c.name, code: c.code, city: sp ? SPECIAL_TRANSPORT_LABEL[sp] : null }
  }))
  return (q: string) => find(q).map((x) => byId.get(x.id)!)
}

/** "RAPIDO TRANSPAULO LTDA" + " · cód. 12" (+ situação especial / inativa) */
const labelParts = (c: PickerTransportCompany) => {
  const sp = specialTransportCompany(c)
  return { name: c.name, detail: ` · cód. ${c.code}${sp ? ` — ${SPECIAL_TRANSPORT_LABEL[sp].toLowerCase()}` : ''}${c.active ? '' : ' · inativa'}` }
}
const label = (c: PickerTransportCompany) => transportCompanyLabel(c) + (c.active ? '' : ' · inativa')

/**
 * TRANSPORTADORA da carga com BUSCA (código do ERP ou nome): as filiais com o mesmo nome se distinguem pelo
 * código ("PLIMOR · cód. 52"). Grava o id (campo oculto `name`, vazio = a definir). Inativas não aparecem para
 * uma escolha nova, mas a já vinculada continua visível (e escolhida). `featured`: grupos no topo antes de
 * digitar (ex.: "Última usada por este cliente", "Especiais").
 */
export function TransportCompanyPicker({
  companies,
  value,
  onChange,
  name,
  disabled,
  featured,
  emptyLabel = '— a definir —',
  inputStyle,
}: {
  companies: PickerTransportCompany[]
  value: number | null
  onChange: (id: number | null) => void
  /** input hidden com o id */
  name?: string
  disabled?: boolean
  featured?: { label: string; ids: number[] }[]
  emptyLabel?: string
  inputStyle?: React.CSSProperties
}) {
  // a vinculada ao abrir a tela fica na lista mesmo inativa (dá para voltar a ela depois de trocar)
  const [linked] = useState(value)
  const items = useMemo(() => companies.filter((c) => c.active || c.id === value || c.id === linked), [companies, value, linked])
  return (
    <SearchPicker
      idPrefix="transportadoras"
      items={items}
      value={value}
      onChange={onChange}
      name={name}
      featured={featured}
      inputStyle={inputStyle}
      disabled={disabled}
      searchFactory={searchFactory}
      labelParts={labelParts}
      label={label}
      texts={{
        emptyLabel,
        searchPlaceholder: 'buscar: nome ou código do ERP',
        closedPlaceholder: `${emptyLabel} · clique para buscar nome ou código`,
        clearLabel: 'Limpar transportadora',
        clearTitle: `Limpar (volta para “${emptyLabel}”)`,
        listLabel: 'Transportadoras',
        restLabel: 'Cadastradas',
        restLabelAlone: 'Transportadoras cadastradas',
        noResults: (q) => `Nenhuma transportadora com “${q}”. Confira o código do ERP; se ainda não estiver cadastrada, deixe “${emptyLabel}” e anote nas observações.`,
        more: (n) => `+ ${n} transportadoras — continue digitando para filtrar`,
        found: (n) => (n === 1 ? '1 transportadora encontrada. ' : `${n} transportadoras encontradas. `),
      }}
    />
  )
}
