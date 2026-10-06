/** Process-group launcher. An orphaned controller must not leave an editing host alive. */
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(2);
const parent = process.ppid;
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
const timer = setInterval(() => {
  if (process.ppid !== parent) {
    if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL');
    else { child.kill('SIGKILL'); process.exit(137); }
  }
}, 250);
child.on('error', error => { console.error(error.message); clearInterval(timer); process.exit(127); });
child.on('exit', (code, signal) => { clearInterval(timer); process.exit(code ?? (signal ? 128 : 1)); });
