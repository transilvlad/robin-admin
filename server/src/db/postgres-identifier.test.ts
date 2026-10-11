import { describe, expect, it } from 'vitest';
import { quotePostgresIdentifier, validatePostgresIdentifier } from './postgres-identifier.js';

describe('PostgreSQL identifier validation', () => {
  it('accepts and quotes unqualified identifiers', () => {
    expect(validatePostgresIdentifier('existing_robin_configs')).toBe('existing_robin_configs');
    expect(quotePostgresIdentifier('Robin_Config_2')).toBe('"Robin_Config_2"');
  });

  it.each([
    '',
    '2robin_configs',
    'public.robin_config_store',
    'robin-config-store',
    'robin_config_store; DROP TABLE admins',
    'a'.repeat(64),
  ])('rejects unsafe or unsupported identifier %j', (value) => {
    expect(() => validatePostgresIdentifier(value)).toThrow(/must start with a letter or underscore/);
  });
});
