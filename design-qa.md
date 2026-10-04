# 财报数据阅读页 — 2026-10-04

- 设计参考：`/workspace/generated_images/exec-61a677bb-d6cd-4512-a39a-30d9af2401d6.png`。最终页面与参考已在同一轮通过 `view_image` 检查。
- 浏览器证据：`outputs/financial-data/balance-final.png`、`income-final.png`、`income-negative-final.png`、`mobile-values-final.png`、`expanded-final.png`、`history-final.png`。桌面 1536×1024，手机 390×844，Playwright Chromium。
- 页面采用白色阅读区、海军蓝导航、靛蓝选中态，保留现有应用导航。公司筛选、财报期间、报表分类、表内搜索与展开阅读形成主要操作层级，更新记录与季度摘要按需打开。
- 与概念的有意差异：保留真实报表的全部行、期间、合并单元格、单位与未识别英文名称，不采用概念中的示例金额。较宽的原表可横向滚动，固定项目列。原始出处数据仍保留在后台，阅读页不显示出处按钮与技术档案。
- 验证使用真实签名会话、管理接口和已迁移的隔离 SQLite/R2 内存数据；利润表来自项目中的真实 SEC 17 列原表样本，其他测试记录用于覆盖合并表头、缺失值和所有导航类别。截图中的测试记录不代表生产财报状态。
- 修复并复验：拆成两格或三格的负数括号被列宽拉开；手机固定首列遮挡金额。最终金额完整且不换行，手机项目列不超过 220px，横向滚动后数值仍可读取，无页面横向溢出。
- 交互通过：中英文搜索与上下条定位、无结果状态、类别和期间切换、紧凑显示、展开/收起及 Esc 焦点恢复、季度对比与金额单位、更新记录、重试、排队/运行/停止状态轮询、添加公司。
- 数据验证：统一显示最近成功保存的数据；失败或待处理更新不覆盖已有结果；零和缺失值保持区分，小数精度与原始金额不变。原始数字不会因 XBRL scale 再次缩放。
- 513 项 Pipeline 测试、14 项定向前端/代理测试、admin/Pipeline 类型检查、admin 构建、边界检查和修改文件 ESLint 通过。浏览器无 JavaScript 或接口错误。
- 本次未部署，未读取或修改生产数据。验证服务和内存数据已关闭，无仓库 mock 或代理配置残留。保留现有公司 logo fallback；远程 logo 可用性不作为此次验收前提。

最终结果：通过。

# 独立 Admin Worker 迁移验证

沿用已批准设计，未重新设计。页面及管理代理已移动到 `apps/admin/`；报告阅读组件、CSS、文案和数据契约复用原实现。按前端技能的验证流程检查迁移后的实现。

- Browser/IAB 工具不可用，使用 Playwright Chromium；开发和生产预览均验证登录、真实隔离 SQLite 的正文、检查标记、确认/取消重新生成、重复提交防护、历史、搜索及移动端。
- 浏览器请求经独立 Worker 的 `handleAdminRequest` 和 HTTP Service Binding，再调用实际 Pipeline handlers；不在生产环境生成报告。
- 已通过 view_image 检查批准参考 `/workspace/generated_images/exec-fc5acb5d-8418-40e0-a29b-6de1aaf8cb59.png` 与迁移后截图 `outputs/report-admin/desktop-before.png`。
- 核对侧栏宽度与结构、列表/正文布局、Geist 字体层级、白/海军蓝/靛蓝配色、工具栏操作、行间距与分隔线；保持原设计。参考 1487×1058，截图 1440×1024（与上次一致）；移动端 390×844 无横向溢出。
- 首屏文案未新增、删除或重排；唯一导航变化是“返回 Spontra”指向独立主站域名。
- 数据及公司名称差异沿用此前明确的真实报告适配；本地远程 logo 被阻断时保留 ticker fallback。未新增视觉偏差。
- 218 项主站单元测试、11 项定向 Pipeline 管理测试、admin/main 类型检查和生产构建、边界检查、ESLint、admin dry-run 打包通过。

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
