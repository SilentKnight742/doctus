import type { Row, WidgetData, WidgetType } from '../api/types'

/** Header labels for a table's item columns, when the type names them in data. */
export function itemColumns(type: WidgetType, data: WidgetData): string[] | undefined {
  const key = type.view_options.columns
  if (!key) return undefined
  const rows = data[key]
  if (!Array.isArray(rows)) return undefined
  const names = rows.map((r) => String((r as Row).name ?? '')).filter(Boolean)
  return names.length ? names : undefined
}
