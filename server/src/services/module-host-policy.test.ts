import { expect, it } from 'vitest';
import { defaultModuleHostPolicy, validateModuleHostPolicy } from './module-host-policy.js';
it('defaults account-data capabilities off and bounds upload resource use', () => {
  const { slug: _slug, ...policy } = defaultModuleHostPolicy('example');
  expect(policy.directoryRead).toBe(false); expect(policy.lifecycleRead).toBe(false);
  expect(validateModuleHostPolicy(policy)).toBe(true);
  for (const changes of [{ maxBodyMiB: 0 }, { maxBodyMiB: 65 }, { maxBodyMiB: 1.5 }, { timeoutSeconds: 121 }, { directoryRead: 'true' }, { rogue: true }]) {
    expect(validateModuleHostPolicy({ ...policy, ...changes })).toBe(false);
  }
});
