import { createServer } from 'node:http';

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    console.log(JSON.stringify({ method: req.method, path: req.url, body: body === '' ? null : JSON.parse(body) }));
    res.writeHead(204).end();
  });
}).listen(8080, '::', () => console.log('deny-stub listening'));
