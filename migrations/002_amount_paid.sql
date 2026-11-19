-- Сколько клиент фактически заплатил (amountPaid внешнего API), в копейках.
-- Процент скидки не храним: он выводится из amount и amountPaid, а источник правды по деньгам — amountPaid.
ALTER TABLE orders ADD COLUMN amount_paid_kop BIGINT;

-- Заказы, сохранённые до появления скидок в API, считаем оплаченными без скидки.
-- Повторный синк их не обновит: версия с тем же updatedAt считается повтором (stale).
UPDATE orders SET amount_paid_kop = amount_kop;

ALTER TABLE orders ALTER COLUMN amount_paid_kop SET NOT NULL;
