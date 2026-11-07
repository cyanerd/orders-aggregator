import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { Order, OrdersRepository } from "../repositories/orders.js";
import { applyDiscount, parseKop, parsePercent } from "../utils/money.js";
import { parseUtc } from "../utils/time.js";

/** Заказ в формате внешнего API (поля, которые нам нужны; остальные игнорируем). */
const ExternalOrder = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
  // Появились в API недавно: у старых заказов их нет вовсе
  discountPercent: z.union([z.number(), z.string()]).nullish(),
  amountPaid: z.union([z.number(), z.string()]).nullish(),
  status: z.enum(["pending", "paid", "refunded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApplyResult = "created" | "updated" | "stale";

export class OrdersService {
  constructor(private readonly orders: OrdersRepository) {}

  normalize(raw: unknown): Order {
    const parsed = ExternalOrder.safeParse(raw);
    if (!parsed.success) throw new ValidationError(`invalid order: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const o = parsed.data;
    try {
      const amountKop = parseKop(o.amount);
      const discountPercent = o.discountPercent == null ? 0 : parsePercent(o.discountPercent);
      const paidKop =
        o.amountPaid != null
          ? parseKop(o.amountPaid, "amountPaid")
          : // amountPaid нет: без скидки это сама сумма, со скидкой — считаем сами (доли копейки отбрасываем)
            applyDiscount(amountKop, discountPercent);
      if (paidKop > amountKop) throw new Error(`amountPaid ${o.amountPaid} exceeds amount ${o.amount}`);
      return {
        id: o.id,
        customerId: o.customerId,
        amountKop,
        discountPercent,
        paidKop,
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
   * Вебхуки приходят с повторами, не по порядку и параллельно, поэтому версия сохраняется,
   * только если она новее уже сохранённой (по updatedAt); сравнение — атомарно в БД.
   */
  async apply(raw: unknown): Promise<ApplyResult> {
    return this.orders.saveIfNewer(this.normalize(raw));
  }
}
