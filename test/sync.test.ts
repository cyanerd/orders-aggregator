import { describe, expect, it } from "vitest";
import { apiOrder, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /sync", () => {
  it("проходит все страницы и останавливается на пустой странице с тем же курсором", async () => {
    const [a, b, c] = [apiOrder(), apiOrder(), apiOrder()];
    ctx.api.pages.set(null, { items: [a, b], nextCursor: "p2" });
    ctx.api.pages.set("p2", { items: [c], nextCursor: "p3" });
    ctx.api.pages.set("p3", { items: [], nextCursor: "p3" });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pages: 3, received: 3, applied: 3, invalid: 0 });
    const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM orders`);
    expect(rows[0].n).toBe(3);
  });

  it("невалидные заказы пропускает, а не падает", async () => {
    ctx.api.pages.set(null, {
      items: [apiOrder(), { id: "broken" }, apiOrder({ amount: "abc" }), apiOrder({ amount: 1e21 })],
      nextCursor: null,
    });
    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    // Огромная сумма — тоже невалидный заказ, а не ошибка БД (BIGINT), которая обрывала бы весь синк
    expect(res.json()).toMatchObject({ received: 4, applied: 1, invalid: 3 });
  });

  it("не откатывает более свежую версию заказа", async () => {
    const fresh = apiOrder({ status: "refunded", updatedAt: "2026-02-12T00:00:00Z" });
    await ctx.app.inject({ method: "POST", url: "/webhooks/order", payload: fresh });
    ctx.api.pages.set(null, { items: [{ ...fresh, status: "paid", updatedAt: "2026-02-10T12:00:00Z" }], nextCursor: null });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.json()).toMatchObject({ stale: 1 });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [fresh.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("строковые суммы и даты без зоны", async () => {
    const o = apiOrder({ amount: "2500.00", createdAt: "2026-02-10T21:30:00" });
    ctx.api.pages.set(null, { items: [o], nextCursor: null });
    await ctx.app.inject({ method: "POST", url: "/sync" });
    const { rows } = await ctx.db.query(`SELECT amount_kop, created_at FROM orders WHERE id = $1`, [o.id]);
    expect(Number(rows[0].amount_kop)).toBe(250000);
    expect(rows[0].created_at.toISOString()).toBe("2026-02-10T21:30:00.000Z");
  });

  it("дозаполняет скидки у строк, сохранённых до их появления, той же версией заказа", async () => {
    const o = apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900 });
    await ctx.app.inject({ method: "POST", url: "/webhooks/order", payload: o });
    // Так выглядит строка после миграции 002: скидка неизвестна
    await ctx.db.query(`UPDATE orders SET paid_kop = NULL, discount_percent = NULL`);

    ctx.api.pages.set(null, { items: [o], nextCursor: null });
    const first = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(first.json()).toMatchObject({ applied: 1, stale: 0 });
    const { rows } = await ctx.db.query(`SELECT paid_kop FROM orders WHERE id = $1`, [o.id]);
    expect(Number(rows[0].paid_kop)).toBe(90000);

    // Повторный синк той же версии — уже stale
    const second = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(second.json()).toMatchObject({ applied: 0, stale: 1 });
  });
});
