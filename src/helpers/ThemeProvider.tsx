import { useEffect, useState, type ReactNode } from 'react';
import { initialTheme, THEME_STORAGE_KEY, ThemeContext, type Theme } from './theme';

// Holds the app-wide theme, applies it as a class on <html>, and remembers the choice.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
