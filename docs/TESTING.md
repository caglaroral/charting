# Testing

End-to-end tests use [Playwright](https://playwright.dev) against a running instance
(Docker or `python3 server.py`). They create three throw-away users (plans *pro*, *free* and *unlimited*) through
the admin API, run in a single worker (shared backend and exchange rate limit) and **purge** the users
afterwards (`DELETE /api/admin/users/{id}?purge=1`), so no layouts, drawings, alerts or scripts of test
users stay in ClickHouse. Global setup also purges `e2e_*` users left by an interrupted run.
The admin account is only used to manage users and open admin dialogs; no test changes its workspace. Expected run time: ~4 minutes.

```bash
cd tests/e2e
npm install
npx playwright install chromium          # add --with-deps on supported distributions
E2E_ADMIN_USER=admin E2E_ADMIN_PASS=… npx playwright test
E2E_BASE_URL=http://host:8080 …          # another instance (default http://localhost:8080)
npx playwright show-report               # HTML report, traces and screenshots of failures
```

Backend unit tests (line alert geometry: bar index across data gaps, log scale, extend), no server needed:

```bash
python3 -m unittest tests/backend/test_alert_geometry.py
```

## Test cases

| ID | Area | Scenario | Expected result |
| --- | --- | --- | --- |
| TC-AUTH-01 | Auth | Login with a wrong password | Error shown, `/api/me` stays 401 |
| TC-AUTH-02 | Auth | Login, reload, logout | Chart opens, session survives reload, logout ends it, no page errors |
| TC-AUTH-03 | Auth | Call data endpoints without a session | 401 for symbols, watchlists, alerts, scripts, drawings, settings |
| TC-AUTH-04 | Tenancy | User A writes a drawing, user B lists drawings; B calls an admin endpoint | B never sees A's data; 403 for admin API |
| TC-AUTH-05 | Input validation | SQL-like symbol, invalid timeframe, invalid alert | 404 / 400, no server errors |
| TC-CHART-01 | Live data | Open the chart | Bars from Binance REST, exactly one exchange websocket, OHLC legend |
| TC-CHART-02 | Timeframes | Toolbar buttons and full timeframe menu | Bar spacing matches the timeframe (15m = 900 s, 4h = 14400 s) |
| TC-CHART-03 | Chart types | Switch through all 15 chart types | Each renders; Renko bricks have a constant size; no page errors |
| TC-CHART-04 | Time zones | Open the list, pick UTC and Tokyo | > 60 zones; axis offset 0 and +9 h |
| TC-CHART-05 | Scale | A (auto) and L (log) buttons, reload | Price scale mode/auto toggle, buttons reflect it, both are restored after reload |
| TC-CHART-06 | History | Scroll to the first bar | Older bars loaded from ClickHouse |
| TC-CHART-07 | History | Live-only symbol, scroll back | "No data on ClickHouse" warning |
| TC-CHART-08 | Search | Type a symbol on the chart, Enter | Search opens, symbol switches |
| TC-IND-06 | Legend | Hover an indicator legend row during live updates | Row is not re-created, buttons stay visible |
| TC-IND-07 | Pane scale | A / L on an indicator pane; L on the price pane | Pane scale independent of the price pane, persisted |
| TC-SCRIPT-06 | Editor docs | Docs button in the editor header | Reference opens in a new tab, editor keeps full width |
| TC-SCRIPT-07 | plotshape | Diamonds at location top / bottom, then scroll | Shapes at the pane top / bottom edge, they stay there while scrolling |
| TC-CHART-10 | Navigation | Scroll back; » button; Alt+Shift+→ | Button shows only when the last bar is off screen, both return to it |
| TC-CHART-11 | Navigation | Center 20 Sep on 1D, switch to 4h and 15m; then at the latest bar switch to 1h | Same date in the middle, same number of bars on screen (history loaded as needed); at the latest bar the chart stays there |
| TC-IND-08 | History | Load older bars with an indicator on the chart | Results stay aligned with their bars, legend unchanged |
| TC-CHART-09 | Chart settings | Change body/wick colors, save, reload; Cancel; Defaults | Colors applied live and persisted, Cancel reverts, Defaults restores |
| TC-WL-01 | Watchlist | Add a symbol, wait, reload, remove | Live quote appears, persisted, removed |
| TC-WL-02 | Watchlist | Click rows | Chart switches, active row highlighted |
| TC-WL-03 | Watchlist | New list, delete list | List created empty, deleted after confirmation |
| TC-DRAW-01 | Drawings | Draw **every** tool of every group from the toolbar flyouts (clicks, drags, multi-point) | One drawing per tool, each rendered with hit geometry, no page errors |
| TC-DRAW-02 | Drawings | Trend line: restyle, reload, select on the line, Delete, Ctrl+Z, Ctrl+Y | Style persisted, delete/undo/redo work |
| TC-DRAW-03 | Drawings | Switch timeframe and symbol | Drawings shared across timeframes, separate per symbol |
| TC-DRAW-04 | Cursors | Eraser, Measure, Zoom | Eraser deletes; measure is temporary; zoom narrows the range |
| TC-DRAW-05 | Defaults | Change a trend line's color and width, draw again, reload, draw again | New trend lines use the changed color / width (saved per user); other tools keep their defaults |
| TC-IND-01 | Indicators | Add every built-in (admin, unlimited plan) | All compute non-empty plots, panes created, no errors |
| TC-IND-02 | Indicators | Add RSI from picker, change length, hide, remove | Legend shows `RSI 21`, visibility toggles, pane removed |
| TC-IND-03 | Panes | Move up/down (also above the price pane), collapse, reload, expand, maximize/restore, delete | Order and collapse persist, price legend follows its pane |
| TC-IND-04 | Indicators | Compare RSI with a reference Wilder RSI | Equal within 1e-6 |
| TC-IND-05 | Plans | Exceed indicators-per-chart limit | Extra indicators refused with a plan message |
| TC-SCRIPT-01 | ChartScript | New script from template, Run, Save & add | Run summary, indicator on chart with inputs in legend |
| TC-SCRIPT-02 | ChartScript | Reference error on line 3 | Error box with message and `line 3` |
| TC-SCRIPT-03 | Sandbox | Infinite loop; probe `document`/`parent`; `fetch` | Timeout without freezing the page; no DOM access; network blocked |
| TC-SCRIPT-04 | Pine port | SqueezeWt | Own pane, 13 plots, 2 signals, legend identical to TradingView, histogram drawn with 4px bars like Pine |
| TC-SCRIPT-05 | Pine port | ALL SMAs (4H `security()`, `fill()`) | Overlay, 4H MA populated, gradient fill present |
| TC-ALERT-01 | Alerts | Price alert from toolbar, toggle, delete | Listed, alert line on chart, paused, deleted |
| TC-ALERT-02 | Alerts | Alert on a horizontal line | Drawing alert stored, bell marker on the drawing |
| TC-ALERT-03 | Alert engine | RSI greater than 0 | Server engine evaluates the indicator and fires; in-app toast |
| TC-ALERT-04 | Plans | Free user: 6 alerts, e-mail channel | 6th → 402; e-mail refused and disabled in the dialog |
| TC-ALERT-05 | Notifications | Save e-mail/webhook, invalid webhook | Persisted; invalid URL → 400 |
| TC-ALERT-06 | History | Price alert with a failing webhook fires | Log has created, triggered, delivered (in-app), failed (webhook, with error), stopped, deleted; tab and dialog filters show it |
| TC-ALERT-07 | Lines | Trend line extended right, chart on log scale, "less than" alert | The server fires: the level is computed in log price and beyond the line's points (linear or not extended would not fire) |
| TC-ALERT-08 | Timeframe | Open the alert dialog; closed above on "Chart", closed below on 4h; edit | List starts with "Chart (1 hour)" (default) and has the symbol's timeframes; alerts saved with 1h / 4h; editing shows the alert's timeframe |
| TC-ADMIN-01 | Data sources | Edit source, Test connection, Scan tables | Connected, OHLC tables listed |
| TC-ADMIN-02 | Admin | Plans and Users dialogs; non-admin menu | Limits shown, plan assigned, no admin menu for users |
| TC-PERSIST-01 | Workspace | Change symbol, timeframe, chart type, indicators, draw; logout/login | Everything restored |

## Manual checks

- Telegram / e-mail delivery: configure *Notification servers*, then **Send test** in
  *user menu → Notifications*.
- Rate limit headroom: `GET /api/admin/ratelimit` shows the exchange weight used by the backend.
