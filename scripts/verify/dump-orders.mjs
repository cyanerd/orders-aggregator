// Выгружает все заказы из внешнего API в JSON-массив: node scripts/verify/dump-orders.mjs orders.json [baseUrl]
// Идёт медленно (≈3 rps). На 429, 5xx, { error } в теле, сетевые ошибки и таймаут ждёт и повторяет,
// но не больше MAX_RETRIES подряд.
import { writeFileSync } from "node:fs";

const [out, base = "http://localhost:4000"] = process.argv.slice(2);
if (!out) throw new Error("usage: dump-orders.mjs <out.json> [baseUrl]");
const MAX_RETRIES = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const items = [];
const seen = new Set();
let cursor = null;
let retries = 0;
for (;;) {
  const url = new URL("/orders", base);
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);
  await sleep(300);
  let res = null;
  let body = null;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    body = await res.json().catch(() => null);
  } catch {
    res = null; // сеть или таймаут — тоже временная ошибка
  }
  const transient = !res || res.status === 429 || res.status >= 500 || (res.status === 200 && body?.error);
  if (transient) {
    if (++retries > MAX_RETRIES) throw new Error(`${url}: ${MAX_RETRIES} retries in a row, last: ${res ? `HTTP ${res.status}` : "network error"}`);
    await sleep(1200);
    continue;
  }
  if (res.status !== 200 || !Array.isArray(body?.items)) throw new Error(`${url}: HTTP ${res.status} ${JSON.stringify(body)}`);
  retries = 0;
  items.push(...body.items);
  if (!body.nextCursor || body.items.length === 0) break;
  if (seen.has(body.nextCursor)) throw new Error(`cursor ${body.nextCursor} repeated on a non-empty page`);
  seen.add(body.nextCursor);
  cursor = body.nextCursor;
}
writeFileSync(out, JSON.stringify(items));
console.log(`orders: ${items.length}`);
