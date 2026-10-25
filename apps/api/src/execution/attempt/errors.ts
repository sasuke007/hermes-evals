/**
 * A trial that cannot be set up: a missing MCP secret, an input whose hash
 * does not match, a skill tree that is not what was uploaded, egress refusing
 * the registration, or a container the guard would not create or start. The
 * runner ends the attempt as `execution_error · setup` (plan 8.4) with this
 * message, which names the cause but never holds a secret value.
 */
export class AttemptSetupError extends Error {
  override readonly name = 'AttemptSetupError';
}
