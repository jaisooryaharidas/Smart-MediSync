import { spawn } from 'node:child_process';
for (const cmd of ['node --watch server/index.js', 'npx vite']) spawn(cmd, { shell: true, stdio: 'inherit' });
