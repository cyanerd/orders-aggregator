# Независимый эталон daily-totals по сырым данным внешнего API (без кода сервиса).
# python3 scripts/verify/reference.py orders.json webhooks.ndjson c_7 Europe/Berlin 2026-03-27 2026-03-31
# Итоговая версия заказа — с максимальным updatedAt; день — в таймзоне клиента на момент заказа (zoneinfo);
# деньги — Decimal/целые копейки. Если amountPaid нет: amount * (100 - discountPercent) / 100, доли копейки отбрасываются.
import json
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_FLOOR, Decimal as D
from zoneinfo import ZoneInfo

items_f, wh_f, cust, tzname, d_from, d_to = sys.argv[1:7]


def ts(s: str) -> datetime:
    """ISO 8601; явное смещение учитывается, строка без зоны — UTC (контракт API)."""
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def kop(rub) -> int:
    return int((D(str(rub)) * 100).to_integral_value(ROUND_FLOOR))


state, ties = {}, 0
for o in [*json.load(open(items_f)), *(json.loads(l) for l in open(wh_f))]:
    cur = state.get(o["id"])
    if cur and ts(cur["updatedAt"]) == ts(o["updatedAt"]) and cur != o:
        ties += 1
    if cur is None or ts(o["updatedAt"]) > ts(cur["updatedAt"]):
        state[o["id"]] = o

tz = ZoneInfo(tzname)
days, d = {}, date.fromisoformat(d_from)
while d <= date.fromisoformat(d_to):
    days[d.isoformat()] = [0, 0]
    d += timedelta(days=1)

for o in state.values():
    if o["customerId"] != cust or o["status"] != "paid":
        continue
    day = ts(o["createdAt"]).astimezone(tz).date().isoformat()
    if day not in days:
        continue
    gross = kop(o["amount"])
    if o.get("amountPaid") is not None:
        paid = kop(o["amountPaid"])
    else:
        bp = int((D(str(o.get("discountPercent") or 0)) * 100).to_integral_value())
        paid = gross * (10000 - bp) // 10000
    days[day][0] += gross
    days[day][1] += paid

rub = lambda k: k / 100
print(json.dumps([{"date": k, "total": rub(g), "gross": rub(g), "discount": rub(g - n), "net": rub(n)} for k, (g, n) in days.items()]))
print(f"orders: {len(state)}, conflicting versions with equal updatedAt: {ties}", file=sys.stderr)
