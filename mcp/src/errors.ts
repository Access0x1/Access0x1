/**
 * Named error classes. Fail-fast guard clauses throw these at the entry of a
 * function so a caller (or the boot sequence) gets a precise, named failure
 * instead of a silent coercion or a generic Error.
 */

/**
 * A required piece of configuration is missing or malformed (e.g. no manifest
 * source is configured). Thrown at boot so the process exits with a clear reason
 * rather than starting in a half-broken state.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The manifest could not be loaded (no source succeeded) or its contents failed
 * validation. Carries which sources were attempted so the operator can fix the
 * right one.
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * A tool was called with arguments that pass the schema but violate a semantic
 * rule the schema cannot express (e.g. neither of two mutually-exclusive fields
 * was supplied). Surfaced back to the model as a tool error, never thrown past
 * the transport.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
