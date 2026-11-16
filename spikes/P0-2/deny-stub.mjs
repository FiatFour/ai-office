import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';

createServer(async (req, res) => {
  const body = await text(req);
  console.log(JSON.stringify({ method: req.method, path: req.url, body: body === '' ? null : JSON.parse(body) }));
  res.writeHead(204).end();
}).listen(8080, '::', () => console.log('deny-stub listening'));
