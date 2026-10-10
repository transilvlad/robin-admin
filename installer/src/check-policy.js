import { validatePolicyFile } from './installer.js';

try {
  await validatePolicyFile(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
