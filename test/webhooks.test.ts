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

  it("параллельные повторы одного события: создаёт ровно один, остальные — stale", async () => {
    // Несколько заказов одновременно, каждый по 8 раз — как шлёт внешняя система
    const orders = Array.from({ length: 10 }, () => apiOrder());
    const sends = orders.flatMap((o) => Array.from({ length: 8 }, () => ({ id: o.id, res: postWebhook(ctx.app, o) })));
    const results = await Promise.all(sends.map(async (s) => ({ id: s.id, result: (await s.res).json().result })));
    for (const o of orders) {
      const mine = results.filter((r) => r.id === o.id).map((r) => r.result);
      expect(mine.filter((r) => r === "created")).toHaveLength(1);
      expect(mine.filter((r) => r === "stale")).toHaveLength(7);
    }
  });

  it("параллельные версии вперемешку: в БД остаётся самая свежая", async () => {
    const o = apiOrder({ status: "pending", amount: 100, updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, o);
    const versions = [
      { ...o, status: "paid", amount: 90, updatedAt: "2026-02-10T13:00:00Z" },
      { ...o, status: "paid", amount: 70, updatedAt: "2026-02-10T14:00:00Z" },
      { ...o, status: "refunded", amount: 70, updatedAt: "2026-02-10T15:00:00Z" },
    ];
    // Каждая версия несколько раз, старые — после новых, всё одновременно
    const burst = [2, 1, 0, 2, 0, 1, 0, 2, 1, 0].map((i) => versions[i]);
    for (let round = 0; round < 5; round++) {
      await Promise.all(burst.map((v) => postWebhook(ctx.app, v)));
      const { rows } = await ctx.db.query(`SELECT status, amount_kop, updated_at FROM orders WHERE id = $1`, [o.id]);
      expect(rows[0]).toMatchObject({ status: "refunded", amount_kop: "7000" });
      expect(rows[0].updated_at.toISOString()).toBe("2026-02-10T15:00:00.000Z");
    }
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });
});
