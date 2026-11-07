// Принимает вебхуки и пишет тела построчно (NDJSON): node scripts/verify/capture-webhooks.mjs webhooks.ndjson [port]
// Затем: docker compose run --rm orders-api webhooks --target http://host.docker.internal:3999/webhooks/order
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [out, port = "3999"] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(out, body + "\n");
    res.writeHead(200, { "content-type": "application/json" }).end('{"result":"captured"}');
  });
}).listen(Number(port), () => console.log(`capturing on :${port}`));
