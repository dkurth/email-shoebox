// Light or dark mode: the moon button's choice (remembered in this browser), else the system setting.
// index.html sets the first value before the page paints; this keeps it up to date.
import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "theme";
const system = matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

const current = (): Theme => stored() ?? (system.matches ? "dark" : "light");

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [dark: boolean, toggle: () => void] {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    // Until the user picks one, follow changes to the system setting.
    const onChange = () => {
      if (!stored()) setTheme(current());
    };
    system.addEventListener("change", onChange);
    return () => system.removeEventListener("change", onChange);
  }, []);
  useEffect(() => apply(theme), [theme]);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private window: the choice lasts until reload */
    }
    setTheme(next);
  };
  return [theme === "dark", toggle];
}
