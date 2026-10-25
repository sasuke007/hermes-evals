/**
 * A run's time budget (plan 7.1): the configuration version's
 * time_budget_s, replaced by the experiment's time_budget_override_s when
 * the launch set one. Replaced, not capped: the form offers a per-run
 * budget for the whole experiment, so every arm gets the same budget, which
 * is what a controlled comparison wants, and the launch estimate assumes it.
 * Execution, recovery's deadline, the inspector's limits, the Overview's
 * timing and every estimate use this one rule. A task's own
 * limits.run_budget_seconds and max_turns are informational in v1.
 */
export const effectiveBudgetS = (configBudgetS: number, overrideS: number | null): number =>
  overrideS ?? configBudgetS;
