# Live earnings calendar

The main `spontra-app` Worker runs `15 * * * *` (UTC) in its `scheduled` entry point.
It calls `refreshPortfolioEarnings` in `worker/portfolio-jobs.ts` directly. Holdings
come from the portfolio read API through `PORTFOLIO_DATA_SERVICE` and the independent
`PORTFOLIO_READ_TOKEN`. The IBKR schedule remains in `spontra-max-data-sync` and is
unchanged. No earnings request writes portfolio data.

The website reads live held symbols and stores the calendar in D1
`earnings_calendar_state`. The first successful sweep each Beijing day covers one
calendar month (month-end clamped); other sweeps cover the next seven days. Failed
dates retain their original observations and verification times. Missing payloads
are not treated as successful empty calendars. The browser polls the public read
endpoint `/api/earnings` every five minutes and filters reminders to one month.

Nasdaq's calendar does not provide a reliable confirmation flag, so those dates
are always estimated. Reviewed company announcements in `officialAnnouncements`
take precedence and link to the actual official evidence. Currently ORCL's September
2026 announcement is independently verified; this registry is deliberately explicit,
not an automated claim that every company announcement has been verified. Adding a
new confirmed date requires checking its company announcement and recording the
actual verification timestamp. Unknown/unannounced dates must not be invented.

The panel displays source, verification date, latest attempt, partial failures and
observations older than 48 hours. Announcement dates can change; confirmation is
source provenance, not a guarantee against subsequent rescheduling.

Apply `drizzle/0007_earnings_calendar.sql` through the normal deployment migration
step. After deployment, the next main-Worker hourly trigger initializes the calendar.
The business function retains the five-minute cooldown.

The former `/api/internal/earnings/refresh` route and reverse `PORTFOLIO_SERVICE`
binding are retired. See [portfolio ownership and migration](portfolio-data-api.md).
