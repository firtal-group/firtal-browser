const http = require('http');
const { spawn } = require('child_process');
const { checkCdpPort } = require('../../src/health');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('health CDP liveness', () => {
  test('passes when /json/version answers on the CDP port', async () => {
    const child = spawn(process.execPath, [
      '-e',
      `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/test' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
});
`
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake CDP server did not start')), 10000);
      child.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(Number(chunk.toString('utf8').trim()));
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    try {
      expect(checkCdpPort(port, 5000).ok).toBe(true);
    } finally {
      if (!child.killed) {
        child.kill();
      }
    }
  }, 15000);

  test('fails when the recorded CDP port is closed', async () => {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));

    const result = checkCdpPort(port, 200);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`/json/version`);
  });
});
