import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

/** Ожидаемая строка ответа: total = gross, discount = gross - net. Без скидки net = gross. */
const day = (date: string, gross: number, net = gross) => ({ date, total: gross, gross, discount: Math.round((gross - net) * 100) / 100, net });

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([day("2026-02-09", 0), day("2026-02-10", 1000), day("2026-02-11", 349)]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 500)]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 800)]);
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

  it("переход на летнее время: смещение берётся на момент заказа, а не на момент запроса", async () => {
    // Europe/Berlin: до 29.03.2026 02:00 — UTC+1, после — UTC+2
    ctx.api.customers.set("c_b", "Europe/Berlin");
    const order = (amount: number, createdAt: string) => apiOrder({ customerId: "c_b", amount, createdAt, updatedAt: createdAt });
    await postWebhook(ctx.app, order(1, "2026-03-27T22:30:00Z")); // 23:30 +1 → 27.03
    await postWebhook(ctx.app, order(10, "2026-03-27T23:30:00Z")); // 00:30 +1 → 28.03
    await postWebhook(ctx.app, order(100, "2026-03-29T21:30:00Z")); // 23:30 +2 → 29.03
    await postWebhook(ctx.app, order(1000, "2026-03-29T22:30:00Z")); // 00:30 +2 → 30.03 (при +1 было бы 29.03)
    await postWebhook(ctx.app, order(10000, "2026-03-31T22:15:00Z")); // 00:15 +2 → 01.04, вне периода

    const res = await dailyTotals(ctx.app, "c_b", "2026-03-27", "2026-03-31");
    expect(res.json()).toEqual([
      day("2026-03-27", 1),
      day("2026-03-28", 10),
      day("2026-03-29", 100),
      day("2026-03-30", 1000),
      day("2026-03-31", 0),
    ]);
  });

  it("переход на зимнее время и границы периода по местному времени", async () => {
    // Europe/Berlin: 25.10.2026 03:00 → 02:00, после — UTC+1
    ctx.api.customers.set("c_b", "Europe/Berlin");
    const order = (amount: number, createdAt: string) => apiOrder({ customerId: "c_b", amount, createdAt, updatedAt: createdAt });
    await postWebhook(ctx.app, order(1, "2026-10-23T21:59:59Z")); // 23:59:59 +2 → 23.10, до начала периода
    await postWebhook(ctx.app, order(10, "2026-10-23T22:00:00Z")); // 00:00 +2 → 24.10, ровно начало периода
    await postWebhook(ctx.app, order(100, "2026-10-25T22:30:00Z")); // 23:30 +1 → 25.10 (при +2 было бы 26.10)
    await postWebhook(ctx.app, order(1000, "2026-10-25T23:00:00Z")); // 00:00 +1 → 26.10, сразу после конца периода

    const res = await dailyTotals(ctx.app, "c_b", "2026-10-24", "2026-10-25");
    expect(res.json()).toEqual([day("2026-10-24", 10), day("2026-10-25", 100)]);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /customers/:id/daily-totals: скидки", () => {
  it("пример из ТЗ: gross, discount, net, total = gross", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2500, gross: 2500, discount: 412.5, net: 2087.5 }]);
  });

  it("net — фактически оплаченное (amountPaid), с копейками и без потерь на округлении", async () => {
    // Значения из внешнего API, на которых Math.floor(x * 100) терял копейку; строковые поля тоже бывают
    await postWebhook(ctx.app, apiOrder({ amount: 4870, discountPercent: 3, amountPaid: 4723.9 }));
    await postWebhook(ctx.app, apiOrder({ amount: "1467.00", discountPercent: "17", amountPaid: 1217.61 }));
    await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: 0, amountPaid: 100 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    // gross 6437, net 4723.90 + 1217.61 + 100 = 6041.51
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 6437, gross: 6437, discount: 395.49, net: 6041.51 }]);
  });

  it("заказы без полей скидки (старые) — без скидки; без amountPaid — считаем от процента", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000 })); // полей скидки нет
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: null, amountPaid: null }));
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: 25 })); // только процент
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 3000, 2750)]);
  });

  it("скидка в более новой версии заказа пересчитывает net", async () => {
    const o = apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900 });
    await postWebhook(ctx.app, o);
    await postWebhook(ctx.app, { ...o, discountPercent: 33, amountPaid: 670, updatedAt: "2026-02-10T13:00:00Z" });
    await postWebhook(ctx.app, o); // старая версия пришла позже — игнорируется
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([day("2026-02-10", 1000, 670)]);
  });

  it("невалидные скидки — 400", async () => {
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: 100.01 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: 101 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: -5 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: "abc" }))).statusCode).toBe(400);
  });
});
