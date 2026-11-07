import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("сохраняет скидку и сумму оплаты", async () => {
    const o = apiOrder({ amount: "3105", discountPercent: "38", amountPaid: 1925.1 });
    await postWebhook(ctx.app, o);
    const { rows } = await ctx.db.query(`SELECT amount_kop, discount_percent, paid_kop FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0]).toEqual({ amount_kop: "310500", discount_percent: "38.00", paid_kop: "192510" });
  });

  it("оплата больше суммы заказа или скидка вне 0..100 — 400", async () => {
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: 150 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: 120 }))).statusCode).toBe(400);
    // пустая строка — не ноль: иначе заказ молча стал бы скидкой 100%
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: "" }))).statusCode).toBe(400);
  });

  it("параллельная доставка версий одного заказа: остаётся самая новая", async () => {
    // Внешняя система шлёт вебхуки пачками параллельно — повторы и разные версии одного заказа
    // приходят одновременно. Сравнение версий должно быть атомарным, иначе побеждает последняя запись.
    for (let i = 0; i < 20; i++) {
      const base = apiOrder({ status: "pending", updatedAt: "2026-02-10T12:00:00Z" });
      const v2 = { ...base, status: "paid", discountPercent: 10, amountPaid: 900, updatedAt: "2026-02-10T13:00:00Z" };
      const v3 = { ...base, status: "refunded", discountPercent: 33, amountPaid: 670, updatedAt: "2026-02-10T14:00:00Z" };
      await postWebhook(ctx.app, base);
      const results = await Promise.all([v3, v2, v2, v3, v2].map((v) => postWebhook(ctx.app, v)));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const { rows } = await ctx.db.query(`SELECT status, paid_kop FROM orders WHERE id = $1`, [base.id]);
      expect(rows[0]).toEqual({ status: "refunded", paid_kop: "67000" });
    }
  });
});
