# 财报管理看板 — Design QA

- Source visual truth: `/workspace/generated_images/exec-fc5acb5d-8418-40e0-a29b-6de1aaf8cb59.png`.
- Browser-rendered implementation: `/workspace/Spontra/outputs/report-admin/desktop-before.png`.
- Combined comparison: `/workspace/Spontra/outputs/report-admin/comparison.png`.
- Focused reading-region evidence: `/workspace/Spontra/outputs/report-admin/reading-detail.png`.
- Additional states: `outputs/report-admin/login.png`, `regenerate-confirm.png`, `history.png`, `mobile.png`.
- Source pixels: 1487 × 1058; normalized source to 1440 × 1024 for composition comparison. Implementation: 1440 × 1024 CSS/pixels, deviceScaleFactor 1. Mobile: 390 × 844 CSS, density 1.
- State: signed-in report-management screen with the first saved report selected, light theme. Reference uses fictional Tencent data; implementation verification uses synthetic Microsoft records from the real migrated SQLite backend. Company names, exact amounts and report-section count differ intentionally. No production dataset was available to this environment.
- Browser: headless Chromium through Playwright; an in-app browser tool was not available. Browser requests used the real admin proxy and Pipeline handlers against isolated SQLite, with the Workflow binding recorded locally. No live generation was triggered.

## Findings and comparison history

- Pass 1: [P1] existing reader styles placed section headings in a narrow grid track and inherited low-contrast text. Evidence: initial browser capture showed “核心结论” wrapping to two lines and pale conclusion text. Fix: scoped admin typography, paragraph colors and block section headings.
- Pass 1: [P2] legacy metric cards and conclusion columns changed reading density. Fix: use a single conclusion column, restrained inline investment-view surface and row-based metrics. Keep all actual report sections available instead of truncating to the short mock.
- Pass 2: revised browser capture and combined comparison show readable full-width headings, correct contrast, consistent navy/indigo/white hierarchy and the reference's sidebar/list/document structure. No actionable P0/P1/P2 visual findings remain.

## Required fidelity surfaces

- Fonts: Geist with Chinese system fallback; 14px reading text, 22px report title, 27px page title. Reference hierarchy retained. No clipped headings or control labels.
- Layout: 206px navy sidebar, 34% report-list track, remaining document; 24–28px reading padding, understated dividers, no nested cards. Primary action aligns right at desktop size.
- Colors: navy sidebar, white surface, indigo selection/action, blue/green/red semantic statuses; reader-theme colors overridden inside the admin surface.
- Assets: standard library icons and existing company-logo loader reused. Remote logo access unavailable in local verification, so the existing ticker fallback is visible; no raster artwork added. Production logo loading was not verified.
- Copy: actual supported SEC periods/forms replace illustrative non-SEC companies. Explicit login, progress, failure, empty, review, version and confirmation copy. No mock financial values shipped in production UI.

## Interaction verification

- Login through the real signed-session implementation and HttpOnly cookie.
- Real-SQL report list/detail; same page URL retained after hydration.
- Persistent review, correct selected filing generation, confirmation cancellation with zero dispatches, confirmation submission with exactly one dispatch, disabled duplicate generation action.
- Search and no-result state; history tab and task stages.
- Desktop/mobile have no horizontal overflow. No uncaught browser errors.
- Backend tests also cover tampering/expiry, public-reader rejection, review isolation across versions, concurrent regeneration and failed Workflow dispatch.

## Remaining verification limits

- Production domain access is denied by the environment network policy; live authentication, real report reads and Cloudflare auto-build status remain unverified.
- P3: company logos are subject to the existing external provider's availability.

final result: passed

---

# Historical QA record (preserved)

# Position Detail Workspace Dialog — Design QA

Historical visual QA record for the retired dialog UI; not a description of the current deployment or authentication model.

- Source visual truth: `/var/folders/49/38jdkjdd6td5m_rltdcm5bgm0000gn/T/codex-clipboard-e248fff2-fa1e-4581-9fd7-03211facd705.png`
- Final implementation screenshot: `/Users/max/Documents/Codex/2026-07-23/bang/work/design-qa/position-dialog-1440-final.png`
- Full-view comparison: `/Users/max/Documents/Codex/2026-07-23/bang/work/design-qa/source-vs-dialog-1440-final.jpg`
- Responsive evidence: `/Users/max/Documents/Codex/2026-07-23/bang/work/design-qa/position-dialog-820.png`, `/Users/max/Documents/Codex/2026-07-23/bang/work/design-qa/position-dialog-390.png`
- Viewports: desktop `1440 × 1000`, tablet `820 × 1000`, mobile `390 × 844`; device pixel ratio `1`.
- Source pixels: `1836 × 1340`. Final desktop pixels: `1440 × 1000`. Comparison normalized the source to `1392px` wide and compared it with the `1392 × 952` modal crop at equal density.
- State: homepage with the NVDA workspace dialog open. The historical local preview did not have the hosted runtime bindings, so the plan editor rendered its unavailable state.

## Fidelity Review

- Fonts and typography: existing serif/sans families, weights, hierarchy, numeric alignment, and ticker scale match the source.
- Spacing and layout: hero, five-metric summary, instrument table, thesis editor, and planning section preserve the source rhythm inside the added sticky modal toolbar.
- Colors and tokens: paper, navy ink, muted labels, profit green, borders, and backdrop use the existing product tokens.
- Image and asset fidelity: the source contains no raster imagery, logos, illustrations, or non-standard icons; no replacement assets were introduced.
- Copy and content: all holding metrics, contract labels, bilingual section kickers, field copy, and snapshot time remain intact.
- Focused comparison: the full-view montage keeps the table and form text readable, so a second crop was unnecessary.

## Comparison History

- Pass 1 found a P2 desktop proportion mismatch: modal content was narrower than the source and the thesis textarea was too short.
- Fix: expanded the desktop content body to `min(1360px, calc(100% - 48px))`, set the desktop plan editor to `83%`, and raised the textarea to `168px`.
- Pass 2: the final montage shows matching content proportions and vertical rhythm. No P0, P1, or P2 visual findings remain.

## Interaction Checks

- Held-position rows and the add-plan entry open dialogs without changing `/` or creating navigation history.
- Close button, backdrop click, and Escape close the detail dialog; page scroll unlocks and focus returns to the originating row.
- Dialog dimensions are `1392 × 952` at `1440px`, `772 × 952` at `820px`, and full-screen `390 × 844` on mobile.
- No horizontal overflow at any tested breakpoint. Browser console: no warnings or errors.
- Automated coverage verifies the authenticated plan-read route, plan-store save path, no-link homepage entry, responsive CSS, and retained standalone detail route.

## Residual Test Gap

- Plan loading and saving were not exercised in that historical local browser session because runtime bindings were unavailable; the unavailable state and storage/API tests passed.

final result: passed
