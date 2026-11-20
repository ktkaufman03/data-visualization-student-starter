import { useTheme } from './theme';

// An on/off switch for dark mode.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="flex items-center gap-2 text-sm cursor-pointer"
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          isDark ? 'bg-gray-200' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full shadow transition-transform ${
            isDark ? 'translate-x-4.5 bg-gray-900' : 'translate-x-0.5 bg-white'
          }`}
        />
      </span>
      Dark mode
    </button>
  );
}
