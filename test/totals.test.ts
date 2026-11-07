import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 }]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});

describe("daily-totals: скидки", () => {
  it("gross — до скидки, net — сколько заплатили, discount = gross - net, total = gross", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: 0, amountPaid: 2500 }));
    await postWebhook(ctx.app, apiOrder({ amount: "1650.00", discountPercent: "25", amountPaid: 1237.5 }));
    // Заказ до появления скидок — полей нет совсем
    await postWebhook(ctx.app, apiOrder({ amount: 99 }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 4249, gross: 4249, discount: 412.5, net: 3836.5 }]);
  });

  it("считает до копейки там, где double теряет копейку", async () => {
    // 4723.9 * 100 = 472389.99999999994 — раньше floor давал 472389
    await postWebhook(ctx.app, apiOrder({ amount: 5687, discountPercent: 17, amountPaid: 4720.21 }));
    await postWebhook(ctx.app, apiOrder({ amount: 6748.43, discountPercent: 30, amountPaid: 4723.9 }));
    const [day] = (await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json();
    expect(day).toEqual({ date: "2026-02-10", total: 12435.43, gross: 12435.43, discount: 2991.32, net: 9444.11 });
  });

  it("если amountPaid нет, а скидка есть — считает net сам", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: 15 }));
    const [day] = (await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json();
    expect(day).toMatchObject({ gross: 1000, discount: 150, net: 850 });
  });

  it("строка, сохранённая до скидок, считается без скидки, пока её не пересинхронизировали", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900 }));
    await ctx.db.query(`UPDATE orders SET paid_kop = NULL, discount_percent = NULL`);
    const [day] = (await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json();
    expect(day).toMatchObject({ gross: 1000, discount: 0, net: 1000 });
  });
});

describe("daily-totals: переход на летнее время", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Europe/Berlin: 29.03.2026 в 01:00Z часы переводятся с UTC+1 на UTC+2.
  // 28.03 22:30Z — это 23:30 28-го (UTC+1); 29.03 22:30Z — уже 00:30 30-го (UTC+2).
  async function seedAroundDst() {
    ctx.api.customers.set("c_7", "Europe/Berlin");
    await postWebhook(ctx.app, apiOrder({ customerId: "c_7", amount: 100, createdAt: "2026-03-28T22:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ customerId: "c_7", amount: 200, createdAt: "2026-03-29T22:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ customerId: "c_7", amount: 400, createdAt: "2026-03-30T21:59:59" }));
  }

  const expected = [
    { date: "2026-03-28", total: 100 },
    { date: "2026-03-29", total: 0 },
    { date: "2026-03-30", total: 600 },
  ];

  it.each([
    ["зимой", "2026-11-07T12:00:00Z"],
    ["летом", "2026-07-01T12:00:00Z"],
  ])("день заказа считается по смещению на момент заказа, а не на сегодня (сейчас %s)", async (_, now) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    await seedAroundDst();
    const res = await dailyTotals(ctx.app, "c_7", "2026-03-28", "2026-03-30");
    expect(res.json()).toMatchObject(expected);
  });
});
