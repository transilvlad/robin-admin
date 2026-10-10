import { describe, expect, it } from 'vitest';
import { validateServiceDsn } from './fleet-services.js';

describe('Fleet DSN network policy', () => {
  it('validates the real connection target including socket and host overrides', () => {
    expect(validateServiceDsn('mariadb', 'mysql://db.example.test/?socket=/run/mysql.sock', false)).toMatch(/Private/);
    expect(validateServiceDsn('postgres', 'postgresql://db.example.test/app?host=127.0.0.1', false)).toMatch(/Private/);
    expect(validateServiceDsn('postgres', 'postgresql://db.example.test/app?host=/run/postgresql', false)).toMatch(/Private/);
    expect(validateServiceDsn('postgres', 'postgresql://db.example.test/app?hostaddr=169.254.169.254', false)).toMatch(/Private/);
    expect(validateServiceDsn('mariadb', 'mysql://localhost/?socket=/run/mysql.sock', true)).toBeNull();
  });
  it('rejects malformed URLs, unknown options and unsupported TLS modes even for private deployments', () => {
    expect(validateServiceDsn('mariadb', 'mysql://[bad', true)).toMatch(/valid URL/);
    expect(validateServiceDsn('mariadb', 'mysql://db/?ssl=typo', true)).toMatch(/TLS mode/);
    expect(validateServiceDsn('mariadb', 'mysql://db/?password=hidden', true)).toMatch(/unsupported options/);
    expect(validateServiceDsn('mariadb', 'mysql://db/#fragment', true)).toMatch(/fragments/);
    expect(validateServiceDsn('mariadb', 'mysql://db/?ssl=required', true)).toBeNull();
  });
});
