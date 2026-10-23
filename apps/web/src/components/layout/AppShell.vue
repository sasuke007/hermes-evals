<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { Moon, Sun } from 'lucide-vue-next';
import { useThemeStore } from '@/stores/theme';

const nav = [
  { to: '/experiments', label: 'Experiments' },
  { to: '/suites', label: 'Suites' },
  { to: '/configurations', label: 'Configurations' },
  { to: '/resources', label: 'Resources' },
];
const theme = useThemeStore();
</script>

<template>
  <header class="shell">
    <RouterLink to="/experiments" class="brand">Hermes Evals</RouterLink>
    <nav aria-label="Sections" class="nav">
      <RouterLink
        v-for="n in nav"
        :key="n.to"
        :to="n.to"
        class="navlink"
        active-class="is-active"
        >{{ n.label }}</RouterLink
      >
    </nav>
    <div class="spacer" />
    <RouterLink to="/system" class="navlink">System</RouterLink>
    <button
      type="button"
      class="iconbtn"
      :aria-label="theme.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
      @click="theme.toggle()"
    >
      <Sun v-if="theme.theme === 'dark'" :size="16" aria-hidden="true" />
      <Moon v-else :size="16" aria-hidden="true" />
      <span>{{ theme.theme === 'dark' ? 'Light' : 'Dark' }}</span>
    </button>
  </header>
</template>

<style scoped>
.shell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  min-height: 48px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand {
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
  height: 48px;
  display: inline-flex;
  align-items: center;
}
.brand:hover {
  text-decoration: none;
}
.nav {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.navlink {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  border-radius: 4px;
  color: var(--text-2);
  font-weight: 500;
}
.navlink:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.navlink.is-active {
  color: var(--text);
  background: var(--surface-3);
}
.spacer {
  flex: 1 1 0;
}
.iconbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.iconbtn:hover {
  background: var(--surface-2);
  color: var(--text);
}
</style>
