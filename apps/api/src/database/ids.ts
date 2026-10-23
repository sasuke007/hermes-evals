import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/**
 * New primary key: a ULID, 26 characters, time-ordered. Monotonic within the
 * process, so ids created in the same millisecond (every run row of a launch)
 * still sort in creation order. Generated in the app because Postgres 17 has
 * no ULID function; raw SQL inserts must pass ids explicitly.
 */
export const newId = (): string => next();
