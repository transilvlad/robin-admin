import { describe, it, expect } from 'vitest';
import { RSPAMD_MANAGED_FILES, RSPAMD_MANAGED_FILES_BY_KEY, valuesStoreFileName } from './rspamd-config-files.js';

describe('rspamd managed config files', () => {
  it('every file normalizes an empty payload to its defaults and renders the managed marker', () => {
    for (const def of RSPAMD_MANAGED_FILES) {
      const values = def.normalize({});
      expect(values).toEqual(def.defaults);
      const rendered = def.render(values);
      expect(rendered).toContain('# Managed by Robin Admin');
      expect(rendered.trim().length).toBeGreaterThan(0);
    }
  });

  it('redis.conf renders servers/timeout and omits blank optional keys', () => {
    const redis = RSPAMD_MANAGED_FILES_BY_KEY.redis;
    const out = redis.render(redis.normalize({ servers: 'r:6379', timeout: 5 }));
    expect(out).toContain('servers = "r:6379";');
    expect(out).toContain('timeout = 5;');
    expect(out).not.toContain('password');
    expect(out).not.toContain('db =');
    const withOpts = redis.render(redis.normalize({ servers: 'r:6379', db: '2', password: 'p', expandKeys: true }));
    expect(withOpts).toContain('db = "2";');
    expect(withOpts).toContain('password = "p";');
    expect(withOpts).toContain('expand_keys = true;');
  });

  it('logging.inc reflects type/level and drops filename for non-file types', () => {
    const logging = RSPAMD_MANAGED_FILES_BY_KEY.logging;
    const file = logging.render(logging.normalize({ type: 'file', filename: '/var/log/rspamd.log', level: 'debug' }));
    expect(file).toContain('filename = "/var/log/rspamd.log";');
    expect(file).toContain('level = "debug";');
    const syslog = logging.render(logging.normalize({ type: 'syslog' }));
    expect(syslog).toContain('type = "syslog";');
    expect(syslog).not.toContain('filename');
  });

  it('rejects invalid enums/numbers back to safe defaults', () => {
    const logging = RSPAMD_MANAGED_FILES_BY_KEY.logging.normalize({ type: 'bogus', level: 'nope' });
    expect(logging.type).toBe('file');
    expect(logging.level).toBe('info');
    const opts = RSPAMD_MANAGED_FILES_BY_KEY.options.normalize({ dnsTimeout: -5, taskTimeout: 'x' });
    expect(opts.dnsTimeout).toBe(1);
    expect(opts.taskTimeout).toBe(8);
  });

  it('leaves actions.conf to Rspamd Rules', () => {
    expect(RSPAMD_MANAGED_FILES.map((f) => f.fileName)).not.toContain('actions.conf');
  });

  it('derives a distinct values store file name per key', () => {
    expect(valuesStoreFileName('redis')).toBe('robin-admin.redis.values.json');
    const keys = RSPAMD_MANAGED_FILES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
