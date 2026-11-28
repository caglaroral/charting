# Alerts

Alerts are evaluated by the backend, so they keep working (and notify) while no browser is open.

## Kinds

| Kind | Target | Created from |
| --- | --- | --- |
| Price | a price level | **Alert** button, Alerts tab, `Alt+A` |
| Drawing | trend line, ray, extended line, horizontal line/ray, cross line, rectangle, parallel channel — the alert reads the drawing's **current** geometry, so moving the drawing moves the alert | 🔔 in the drawing toolbar |
| Indicator | any plot of a built-in or custom indicator vs. a value or another plot; or a custom `plotshape()` signal | `…` → *Add alert…* on the indicator legend |
| Screener | a saved screen: fires on a closed bar of the screen's timeframe when symbols **newly** match (the message lists them) | **Alert** in the Screener ([SCREENER.md](SCREENER.md)) |

Conditions: *crossing, crossing up, crossing down, greater than, less than, closed above, closed below,
entering channel, exiting channel, signal*. Frequency: *once* (deactivates after firing) or *once per bar*.

**Timeframe**: every alert is evaluated on bars of its own timeframe. The dialog starts with
*Chart (…)*, the chart's current timeframe (the default), followed by the timeframes the symbol has.
The timeframe is stored with the alert, so changing the chart later does not change the alert.

- *crossing / greater / less* also check the bar that is still forming (they fire within the bar);
- *closed above / closed below* only check bars that have **closed**: the close of a finished bar
  above the level (above the upper line of a zone) / below it (below the lower line). With
  *once per bar* they fire on every such closed bar.

### Lines and channels

The engine follows a drawing exactly as it is drawn on the chart:

- the level of a sloped line is interpolated for every bar from its two points, **by bar position,
  not by time**: the chart lays bars out side by side, so a gap in the data (missing bars) takes no
  room on screen and a line drawn across it is straight in bars. The engine maps times to bar positions
  over the same data the chart shows on the user's timeframe (saved layout): the exchange's latest 500
  bars plus the ClickHouse history before them. This map is refreshed every 5 minutes; after its last
  bar it moves one bar per timeframe step, like the chart. Without gaps both ways give the same level;
- a **trend line** and a **parallel channel** only count between their two points, unless
  **Extend left** (←) / **Extend right** (→) is switched on in the drawing toolbar. A **ray** extends
  to the right, an **extended line** both ways. To catch a future breakout, extend the line right;
- on a **log scale** a straight line on screen is straight in log(price), so the engine interpolates
  in log(price) when the user's chart is on a log scale (a channel then keeps a constant ratio
  between its lines). Example: a line from 100 to 200 is at 141.4 halfway on a log scale and at 150
  on a linear scale. Switching the scale changes the line on screen and the alert level together;
- crossing up fires when the previous close was below the line and the bar's high reaches it
  (intrabar), crossing down the other way round; greater / less compare the close.

## Engine

`backend/alerts.py` runs a thread every 20 s:

1. Loads active alerts and applies plan limits (max active alerts per user, evaluation interval).
2. Groups them by `(symbol, timeframe)`, the timeframe chosen in the alert dialog (alerts created
   before the timeframe option keep 1-minute bars for price / drawing alerts).
3. Fetches the latest bars **once per group** from the live provider (ClickHouse for sources without
   one). Indicator groups fetch 600 extra bars of warm-up; afterwards a cache keeps them and only the
   newest bars are requested.
4. Indicators are computed by the Node worker with the browser's own `indicators.js` / `script.js`
   (custom scripts included; `security()` timeframes are fetched on demand).
5. Every bar since the last evaluated one is checked (the forming bar is re-checked each pass, an
   alert fires at most once per bar). Crossing uses the bar's high/low against the level, so
   intrabar touches count.
6. Fired alerts are written to `alert_events` and delivered to the selected channels.

## Notifications

| Channel | Setup |
| --- | --- |
| In-app | always on: toast, sound, browser notification (button *Notifications* in the Alerts tab), badge |
| Telegram | admin: bot token (**Notification servers**); user: chat id (**user menu → Notifications**) |
| E-mail | admin: SMTP host/port/security/user/password/from; user: address |
| Webhook | user: URL — receives a JSON POST `{alert_id, symbol, tf, kind, cond, bar_time, price, message, count}` |

Where to set them up:

- **User**: Alerts tab → **Channels** (or user menu → *Notifications…*): e-mail address, Telegram chat
  id, webhook URL, default channels, **Send test**. The dialog also shows whether the server side
  (SMTP, Telegram bot) is configured.
- **Admin**: user menu → *Notification servers*: SMTP host/port/security/user/password/from and the
  Telegram bot token.
- The alert dialog lists channels that are not configured yet, with a link to the settings.

Channels available to a user are limited by the plan.

## History

Every alert keeps a history (`alert_log`, 180 days):

| Event | When |
| --- | --- |
| Created / Edited / Paused / Resumed / Deleted | changes made by the user |
| Triggered | the engine fired the alert (price and bar time) |
| Sent / Failed | result per channel: in-app, Telegram, e-mail, webhook; failures keep the error text |
| Stopped | deactivated by the engine: *once* alerts after firing, or the drawing / custom indicator was deleted |

The Alerts tab shows the latest entries; **Full history** (or the clock button on an alert) opens the
complete log with filters (alert, triggers, deliveries, failed deliveries, changes) and paging.
API: `GET /api/alerts/log?alert_id=&event=&before=&limit=`.

## Exchange rate limits

Binance limits are per IP and shared with every other client on the same network address, so:

- Browser: one REST request per symbol/timeframe selection and **one** websocket per provider
  (chart and watchlist streams are multiplexed with `SUBSCRIBE`/`UNSUBSCRIBE`), exponential reconnect
  backoff, a watchdog for silent sockets.
- Server: no websockets. REST calls track `X-MBX-USED-WEIGHT-1M`; above 40 % of the IP limit
  (`WEIGHT_BUDGET` in `backend/live.py`) the engine skips the pass, and `418/429` responses pause all
  requests for `Retry-After`. Current usage: `GET /api/admin/ratelimit`.

Run **one** backend instance per database: several instances would evaluate the same alerts twice.
