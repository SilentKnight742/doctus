export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'doctus.theme'

export function loadTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage unavailable
  }
  return 'system'
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try {
    window.localStorage.setItem(KEY, choice)
  } catch {
    // storage unavailable
  }
}
