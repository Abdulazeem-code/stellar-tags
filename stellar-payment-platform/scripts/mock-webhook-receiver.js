// Stands in for a merchant's webhook endpoint during load testing so
// deliveries triggered by artillery-webhooks.yml don't leave the machine.
const http = require('http');

const PORT = Number(process.env.MOCK_RECEIVER_PORT || 5099);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
});

server.listen(PORT, () => {
  console.log(`[mock-webhook-receiver] listening on :${PORT}`);
});
