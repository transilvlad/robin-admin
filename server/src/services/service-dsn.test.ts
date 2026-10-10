import { describe, expect, it } from 'vitest';
import { DSN_PASSWORD_MASK, isDsnFor, maskDsnPassword, restoreDsnPassword, toPublicFleetService } from './service-dsn.js';

describe('service DSNs', () => {
  it('matches each database type to its schemes', () => {
    expect(isDsnFor('postgres', 'postgresql://u@/db?host=/run/postgresql')).toBe(true);
    expect(isDsnFor('redis', 'rediss://cache:6380')).toBe(true);
    expect(isDsnFor('mariadb', 'mysql://u:p@db/app')).toBe(true);
    expect(isDsnFor('mariadb', 'postgresql://db')).toBe(false);
    expect(isDsnFor('dovecot', 'http://dovecot:9900')).toBe(false);
  });

  it('masks a password and leaves a password-less DSN alone', () => {
    expect(maskDsnPassword('mysql://monitor:s3cr@t@db:3306/app')).toBe(`mysql://monitor:${DSN_PASSWORD_MASK}@db:3306/app`);
    expect(maskDsnPassword('redis://cache:6379/0')).toBe('redis://cache:6379/0');
    expect(maskDsnPassword('mysql://monitor@db/app')).toBe('mysql://monitor@db/app');
    expect(maskDsnPassword(null)).toBeNull();
  });

  it('restores the stored password only where the mask came back', () => {
    const stored = 'mysql://monitor:s3cr@t@db:3306/app';
    expect(restoreDsnPassword(`mysql://monitor:${DSN_PASSWORD_MASK}@db2:3306/app`, stored)).toBe('mysql://monitor:s3cr%40t@db2:3306/app');
    expect(restoreDsnPassword('mysql://monitor:new@db:3306/app', stored)).toBe('mysql://monitor:new@db:3306/app');
    expect(restoreDsnPassword(`mysql://monitor:${DSN_PASSWORD_MASK}@db/app`, null)).toBe(`mysql://monitor:${DSN_PASSWORD_MASK}@db/app`);
  });

  it('masks and restores query passwords without leaking duplicate values', () => {
    const stored = 'postgresql://user@db/app?password=first&password=secret%26second';
    const masked = maskDsnPassword(stored)!;
    expect(masked).not.toContain('first');
    expect(masked).not.toContain('secret');
    expect(new URL(masked).searchParams.getAll('password')).toEqual([DSN_PASSWORD_MASK]);
    expect(new URL(restoreDsnPassword(masked, stored)).searchParams.get('password')).toBe('secret&second');
    expect(maskDsnPassword('invalid secret')).toBe('[invalid connection string]');
  });

  it('rejects malformed edits and permits repairing a malformed stored value', () => {
    expect(() => restoreDsnPassword('mysql://[bad', null)).toThrow('must be a valid URL');
    expect(restoreDsnPassword('mysql://monitor:new@db/app', 'malformed')).toBe('mysql://monitor:new@db/app');
  });

  it('masks only database types in API responses', () => {
    expect(toPublicFleetService({ serviceType: 'postgres', metricsUrl: 'postgresql://u:pw@db/x' }).metricsUrl).toBe(`postgresql://u:${DSN_PASSWORD_MASK}@db/x`);
    expect(toPublicFleetService({ serviceType: 'robin', metricsUrl: 'http://u:pw@robin:8080' }).metricsUrl).toBe('http://u:pw@robin:8080');
  });
});
