-- Скидки из внешнего API. paid_kop — сколько клиент фактически заплатил.
-- У строк, сохранённых до этой миграции, скидка неизвестна: paid_kop = NULL до следующего /sync
-- (OrdersService.apply перезаписывает такие строки даже той же версией заказа).
ALTER TABLE orders
  ADD COLUMN discount_percent NUMERIC(5, 2),
  ADD COLUMN paid_kop BIGINT;
