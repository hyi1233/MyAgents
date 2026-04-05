#!/usr/bin/env node
// Claude Code SessionStart hook forwarder (v0.1.59)
// This script is executed by CC as a hook command.
// It reads the hook input from stdin (JSON) and POSTs it to the Sidecar's HTTP endpoint.
// Must be CommonJS (.cjs) for maximum compatibility with CC's hook runner.

const http = require('http');
const port = parseInt(process.argv[2], 10);

if (!port || isNaN(port)) {
  process.exit(0); // Silently exit if no port — don't break CC
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request({
    host: '127.0.0.1',
    port: port,
    method: 'POST',
    path: '/hook/session-start',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  }, (res) => { res.resume(); });
  req.on('error', () => {}); // Silently ignore — don't break CC
  req.end(body);
});
process.stdin.resume();
