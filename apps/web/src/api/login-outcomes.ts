/**
 * How a waiting Nous login can end in fixtures mode: ConnectDialog's development controls
 * and the nous-login-* scenarios. Kept apart from src/fixtures/system.ts so the dialog can
 * list them without importing the fixture world, which a live build leaves out.
 */
export const LOGIN_OUTCOMES = ['approve', 'decline', 'expire', 'subscription', 'fail'] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];
