import type { OrdersRepository } from "../repositories/orders.js";
import { fromKop } from "../utils/money.js";
import { datesBetween } from "../utils/time.js";
import type { CustomersService } from "./customers.js";

export interface DailyTotal {
  date: string;
  /** Для обратной совместимости: то же, что gross. */
  total: number;
  /** Сумма оплаченных заказов до скидки. */
  gross: number;
  /** gross - net. */
  discount: number;
  /** Фактически оплачено. */
  net: number;
}

export class TotalsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Суммы оплаченных заказов клиента по дням в его таймзоне, from..to включительно.
   * Дни без оплат — с нулями. Считаем в копейках, в рубли переводим только на выходе.
   */
  async daily(customerId: string, from: string, to: string): Promise<DailyTotal[]> {
    const timezone = await this.customers.timezone(customerId);
    const sums = await this.orders.paidDailyTotals(customerId, timezone, from, to);
    return datesBetween(from, to).map((date) => {
      const { gross, net } = sums.get(date) ?? { gross: 0, net: 0 };
      return { date, total: fromKop(gross), gross: fromKop(gross), discount: fromKop(gross - net), net: fromKop(net) };
    });
  }
}
