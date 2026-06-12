import { ref, onMounted } from 'vue'

const STORAGE_KEY = 'theme_preference'
const AUTO_MODE_HOUR_START = 6
const AUTO_MODE_HOUR_END = 18
const themeChangeCallbacks = []

const currentTheme = ref('auto')

const resolveTheme = (theme) => {
  if (theme === 'auto') {
    const hour = new Date().getHours()
    return (hour >= AUTO_MODE_HOUR_START && hour < AUTO_MODE_HOUR_END) ? 'light' : 'dark'
  }
  return theme
}

const applyTheme = (theme) => {
  const resolved = resolveTheme(theme)
  document.body.classList.remove('dark', 'light')
  if (resolved !== 'dark') {
    document.body.classList.add(resolved)
  }
  themeChangeCallbacks.forEach(cb => cb(resolved))
}

export const useTheme = () => {
  const getPreferredTheme = () => {
    return localStorage.getItem(STORAGE_KEY) || 'dark'
  }

  const setTheme = (theme) => {
    localStorage.setItem(STORAGE_KEY, theme)
    currentTheme.value = theme
    applyTheme(theme)
  }

  const toggleTheme = () => {
    const themes = ['dark', 'light', 'auto']
    const currentIndex = themes.indexOf(currentTheme.value)
    const nextIndex = (currentIndex + 1) % themes.length
    setTheme(themes[nextIndex])
    return themes[nextIndex]
  }

  const initTheme = () => {
    const saved = getPreferredTheme()
    currentTheme.value = saved
    applyTheme(saved)
  }

  const onThemeChange = (callback) => {
    themeChangeCallbacks.push(callback)
  }

  onMounted(() => {
    initTheme()
  })

  return {
    currentTheme,
    setTheme,
    getPreferredTheme,
    applyTheme,
    toggleTheme,
    initTheme,
    onThemeChange
  }
}

export default useTheme