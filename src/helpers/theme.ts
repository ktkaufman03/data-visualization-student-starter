import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';

export const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: 'light',
  setTheme: () => {},
});

// The current theme, for components that need it in JavaScript (e.g. Google Maps or canvas
// colors). Plain styling should use Tailwind's dark: variant instead.
export function useTheme() {
  return useContext(ThemeContext);
}

// The saved choice if there is one, otherwise the OS setting.
// Keep in sync with the inline script in index.html, which applies it before React loads.
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be blocked (e.g. some private windows); fall back to the OS setting.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
