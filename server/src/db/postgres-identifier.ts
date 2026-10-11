const POSTGRES_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

declare const postgresIdentifierBrand: unique symbol;
export type PostgresIdentifier = string & { readonly [postgresIdentifierBrand]: true };

export function validatePostgresIdentifier(value: string, label = 'PostgreSQL identifier'): PostgresIdentifier {
  const trimmed = value.trim();
  if (!POSTGRES_IDENTIFIER_RE.test(trimmed)) {
    throw new Error(
      `${label} must start with a letter or underscore, contain only letters, numbers, and underscores, and be at most 63 characters`
    );
  }
  return trimmed as PostgresIdentifier;
}

export function quotePostgresIdentifier(value: string): string {
  const validated = validatePostgresIdentifier(value);
  return `"${validated}"`;
}
