/** Element ids linking a tab to its panel (aria-controls / aria-labelledby). */
export function tabId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`
}

export function tabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`
}
