const { spawn } = require('node:child_process');

delete process.env.ELECTRON_RUN_AS_NODE;

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: process.env });

child.on('error', (error) => {
  console.error('Could not start Electron:', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
