import type { WidgetData, WidgetType } from '../api/types'
import { emptyData } from '../schema/validate'

/** Data for a freshly added widget: defaults, with required fields filled in. */
export function starterData(type: WidgetType): WidgetData {
  const data = emptyData(type)
  for (const f of type.fields) {
    if (!f.required) continue
    if (f.type === 'url') data[f.key] = 'https://example.com'
    else if (f.type === 'text') data[f.key] = f.key === type.view_options.title ? `New ${type.label.toLowerCase()}` : '…'
  }
  return data
}
