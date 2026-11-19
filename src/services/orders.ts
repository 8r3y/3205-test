import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { Order, OrdersRepository, SaveResult } from "../repositories/orders.js";
import { parseRub, toKop } from "../utils/money.js";
import { parseUtc } from "../utils/time.js";

/** Заказ в формате внешнего API (поля, которые нам нужны; остальные игнорируем). */
const ExternalOrder = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
  // Появились в API недавно: у старых заказов их нет. Как и amount, бывают строками ("7").
  discountPercent: z.union([z.number(), z.string()]).nullish(),
  amountPaid: z.union([z.number(), z.string()]).nullish(),
  status: z.enum(["pending", "paid", "refunded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApplyResult = SaveResult;

/**
 * Сколько фактически оплачено, в копейках.
 * Источник правды — amountPaid. Без него — считаем от процента; без скидки — вся сумма.
 */
function paidKop(amountKop: number, amountPaid: unknown, discountPercent: unknown): number {
  const percent = discountPercent == null ? 0 : parseRub(discountPercent);
  if (percent > 100) throw new Error(`invalid discountPercent: ${JSON.stringify(discountPercent)}`);
  const paid = amountPaid == null ? Math.round((amountKop * (100 - percent)) / 100) : toKop(parseRub(amountPaid));
  if (paid > amountKop) throw new Error(`amountPaid ${JSON.stringify(amountPaid)} exceeds amount`);
  return paid;
}

export class OrdersService {
  constructor(private readonly orders: OrdersRepository) {}

  normalize(raw: unknown): Order {
    const parsed = ExternalOrder.safeParse(raw);
    if (!parsed.success) throw new ValidationError(`invalid order: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const o = parsed.data;
    try {
      const amountKop = toKop(parseRub(o.amount));
      return {
        id: o.id,
        customerId: o.customerId,
        amountKop,
        amountPaidKop: paidKop(amountKop, o.amountPaid, o.discountPercent),
        status: o.status,
        createdAt: parseUtc(o.createdAt),
        updatedAt: parseUtc(o.updatedAt),
      };
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }

  /**
   * Применяет версию заказа (из синка или вебхука).
   * Вебхуки приходят с повторами, параллельно и не по порядку, поэтому версию сохраняем,
   * только если она новее уже сохранённой (по updatedAt) — атомарно, на стороне БД.
   */
  async apply(raw: unknown): Promise<ApplyResult> {
    return this.orders.saveIfNewer(this.normalize(raw));
  }
}
