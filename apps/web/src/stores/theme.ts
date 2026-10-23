import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'hermes-evals.theme';

function readInitial(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<Theme>(readInitial());

  function apply(value: Theme): void {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable */
    }
  }

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  watch(theme, apply, { immediate: true, flush: 'sync' });
  return { theme, toggle };
});
