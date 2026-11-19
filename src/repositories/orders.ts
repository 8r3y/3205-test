import type { Db } from "../db.js";

export interface Order {
  id: string;
  customerId: string;
  /** Сумма заказа до скидки. */
  amountKop: number;
  /** Фактически оплачено (со скидкой). */
  amountPaidKop: number;
  status: "pending" | "paid" | "refunded";
  createdAt: Date;
  updatedAt: Date;
}

export type SaveResult = "created" | "updated" | "stale";

/** Суммы оплаченных заказов за день, в копейках. */
export interface DayTotalsKop {
  gross: number;
  net: number;
}

interface Row {
  id: string;
  customer_id: string;
  amount_kop: string;
  amount_paid_kop: string;
  status: Order["status"];
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: Row): Order => ({
  id: r.id,
  customerId: r.customer_id,
  amountKop: Number(r.amount_kop),
  amountPaidKop: Number(r.amount_paid_kop),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class OrdersRepository {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Order | null> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM orders WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /**
   * Сохраняет версию заказа, только если она новее сохранённой (по updatedAt).
   * Проверка и запись — одним оператором: параллельные вебхуки с повторами и старыми
   * версиями не могут перезаписать более свежую версию (read-then-write здесь даёт гонку).
   * Версия с тем же updatedAt — повтор, "stale".
   */
  async saveIfNewer(o: Order): Promise<SaveResult> {
    const { rows } = await this.db.query<{ inserted: boolean }>(
      `INSERT INTO orders (id, customer_id, amount_kop, amount_paid_kop, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         customer_id     = excluded.customer_id,
         amount_kop      = excluded.amount_kop,
         amount_paid_kop = excluded.amount_paid_kop,
         status          = excluded.status,
         created_at      = excluded.created_at,
         updated_at      = excluded.updated_at
       WHERE orders.updated_at < excluded.updated_at
       RETURNING (xmax = 0) AS inserted`,
      [o.id, o.customerId, o.amountKop, o.amountPaidKop, o.status, o.createdAt, o.updatedAt],
    );
    if (rows.length === 0) return "stale";
    return rows[0].inserted ? "created" : "updated";
  }

  /**
   * Суммы оплаченных заказов клиента по календарным дням в таймзоне `timeZone`, from..to включительно.
   * День и границы периода считает Postgres (AT TIME ZONE) — с учётом перехода на летнее/зимнее время
   * на момент каждого заказа. Дни без оплат в результат не попадают.
   */
  async paidDailyTotals(customerId: string, timeZone: string, from: string, to: string): Promise<Map<string, DayTotalsKop>> {
    const { rows } = await this.db.query<{ day: string; gross: string; net: string }>(
      `SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
              sum(amount_kop)      AS gross,
              sum(amount_paid_kop) AS net
         FROM orders
        WHERE customer_id = $1
          AND status = 'paid'
          AND created_at >= ($3::date::timestamp AT TIME ZONE $2)
          AND created_at <  (($4::date + 1)::timestamp AT TIME ZONE $2)
        GROUP BY 1`,
      [customerId, timeZone, from, to],
    );
    return new Map(rows.map((r) => [r.day, { gross: Number(r.gross), net: Number(r.net) }]));
  }
}
