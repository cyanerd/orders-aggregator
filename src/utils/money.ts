/**
 * Деньги внутри сервиса — целые копейки. Рубли — только на входе (внешний API) и в ответах.
 */

/** Неотрицательное десятичное число строкой: "250", "250.10". Без экспоненты, hex и пустых строк. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Потолок суммы: 1 трлн ₽ = 1e14 коп. — точно представимо в double и с запасом помещается в BIGINT. */
const MAX_RUB = 1_000_000_000_000;

function parseDecimal(raw: unknown, what: string): number {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    value = DECIMAL_RE.test(s) ? Number(s) : NaN;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${what}: ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Сумма из внешнего API: число или строка с числом ("250.10"). */
export function parseRub(raw: unknown): number {
  return parseDecimal(raw, "amount");
}

/** Процент скидки из внешнего API: число или строка ("33"), от 0 до 100, не точнее сотых (в БД NUMERIC(5,2)). */
export function parsePercent(raw: unknown): number {
  const value = parseDecimal(raw, "discountPercent");
  if (value > 100 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) {
    throw new Error(`invalid discountPercent: ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Рубли → копейки. Доли копейки отбрасываются: деньги клиенту не досчитываем.
 * Не умножаем в double (4723.9 * 100 = 472389.99999999994), а режем десятичную запись числа:
 * String() даёт кратчайшую запись, которая читается обратно в то же число ("4723.9").
 */
export function toKop(rub: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(rub));
  // Экспоненциальная запись бывает только у < 1e-6 и >= 1e21 — для денег это ноль или мусор
  if (!m) return Math.floor(rub * 100);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0").slice(0, 2));
}

/**
 * Сумма из внешнего API (число или строка) → копейки, доли копейки отбрасываются.
 * Строку режем по её десятичной записи, не проходя через double ("4723.8999999999999999" → 472389).
 * Больше MAX_RUB — ошибка: иначе теряется точность, а в БД переполняется BIGINT и падает весь синк.
 */
export function parseKop(raw: unknown, what = "amount"): number {
  if (typeof raw === "string") {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
    if (!m || Number(m[1]) > MAX_RUB) throw new Error(`invalid ${what}: ${JSON.stringify(raw)}`);
    const kop = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0").slice(0, 2));
    if (kop > MAX_RUB * 100) throw new Error(`invalid ${what}: ${JSON.stringify(raw)}`);
    return kop;
  }
  const rub = parseDecimal(raw, what);
  if (rub > MAX_RUB) throw new Error(`invalid ${what}: ${JSON.stringify(raw)}`);
  return toKop(rub);
}

/** Сумма со скидкой `percent` (до сотых): целочисленно, в сотых долях процента; доли копейки отбрасываются. */
export function applyDiscount(kop: number, percent: number): number {
  const basisPoints = Math.round(percent * 100);
  return Math.floor((kop * (10_000 - basisPoints)) / 10_000);
}

/** Копейки → рубли для ответа API. */
export function fromKop(kop: number): number {
  return kop / 100;
}
