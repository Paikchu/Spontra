# Modern Web Guidance 修复与验证

日期：2026-11-14。

原审查发生在旧版保留分支 `codex/preserved-today-5d26cf9` 的工作区。准备发布时核对发现，生产主线已经推进至 `2e01e8fa`，旧版 `app/` 和 `packages/ui/` 已被移除。本次在从 `origin/main` 创建的隔离工作区修复现行实现；没有将旧版页面、原工作区未提交业务改动或测试数据合入主线。

## 原发现的处理结果

| 原问题 | 当前主线与本次处理 |
| --- | --- |
| 页面地址被替换为 `/` | 主线已经改用 `/companies/:ticker`、`pushState` 和 `popstate`。实测刷新、后退及前进保留正确位置。本次补齐切页焦点，并将地址状态和视图更新放在同一页面切换回调中。 |
| 隐藏旧页面继续响应快捷键和轮询 | 主线不再缓存旧版已挂载页面，Home 与 Company 按路由切换挂载。本次实测进入公司后 Home 已移除，首页快捷键只聚焦首页输入框，没有隐藏面板。导航时同步关闭搜索面板。 |
| 重复的搜索输入框 ID | 主线 SearchPanel 已通过 `useId()` 连接组合框、列表和选项。实测路由切换后无重复 ID。本次让弹窗内 SearchPanel 仅在打开时挂载，关闭即清理此次搜索状态。 |
| 自定义模态没有隔离背景 | 主线 SearchDialog 已使用 `showModal()`。本次补齐可点击的关闭按钮，交由浏览器处理模态 Escape；移除 session 更新及 rAF 聚焦的时序依赖，改用输入框 autofocus。验证背景无法获得焦点、Tab 留在弹窗、关闭后焦点返回入口。 |

## 其余审查建议

- **滚动表格**：公共 Table 观察容器及表格的尺寸，仅在实际横向溢出时设置 `tabIndex=0`、region 角色与可访问名称；名称优先复用调用处的表格标签。390px 视口实测 Form 4 历史表可聚焦并由 ArrowRight 滚动；1440px 视口无溢出时不加入 Tab 顺序。
- **样式加载**：旧版全局财报样式随重构移除；现行 FilingReport 的正文和 KaTeX 样式已跟随其动态导入。生产构建确认财报 CSS 为独立资源，而非旧版根布局的全局引入。未以源码体积代替 LCP、INP 或 CLS 测量，也没有进行无关的样式重写。
- **模态关闭兼容性**：使用 `closedby="any"`；不支持该属性的浏览器走小范围指针坐标回退。只有按下和抬起均在弹窗外才关闭，避免点击内边距或拖选结束于外部时误关。补上模态和 backdrop 的滚动链约束。

## 验证

使用仓库已有的 `BUSINESS_SITE_FIXTURES=1` 本地开发模式模拟用户操作，未编写或运行单元测试。ACME 是仓库自带的合成公司；该开发开关未进入生产构建或发布配置。

- 首页搜索 → 公司 → 刷新 → 后退 → 前进：URL 和标题正确；切页后焦点进入 main。
- 首页快捷键：聚焦可见首页输入框，没有打开隐藏 modal。
- 搜索模态：按钮打开、自动聚焦、Tab、关闭按钮、单次 Escape、背景焦点隔离、关闭焦点返回均通过。
- 外部点击与内部拖选：原生行为通过；禁用本页 `closedBy` 能力并移除该属性后的回退分支模拟也通过。回退模拟不等同于真机 Safari 测试。
- 实际 Form 4 表格：窄屏出现带名称的可聚焦滚动区域，方向键可滚动；宽屏恢复为普通容器。
- `npm run check`：通过（本地化、发行人字面量、分析依赖边界、根/地图/admin 类型检查、地图与 admin 构建）。
- 本次修改的 TS/TSX 文件定向 ESLint 与 `git diff --check`：通过。
- 全仓库 `npm run lint`：仍有既存的 10 errors、19 warnings，集中于未修改的后台等文件；不扩大本次前端修复范围。

本地合成数据未覆盖的读取可能返回 502，虚构公司 logo 可能返回 404；这些不作为线上故障证据。发布通过推送 `origin/main` 触发项目原有的两条 Cloudflare Builds，最终线上状态由发布后的构建和实际页面核验确定。

## Modern Web Guidance

来源为已安装的 [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance)。本次主要应用：

- `dialog`：遵循 “put `autofocus` on the primary control or first field”，由原生模态负责背景隔离、Escape 与焦点返回；按指南补充不支持 `closedby` 时的坐标回退。
- `accessibility`：遵循 “Manage focus correctly to and from updated content”，只在用户路由切换时移动焦点，并保留错误页专门将用户送到首页搜索的意图。
- `responsive-table`：遵循 “Add a `tabindex="0"` attribute to the container”，将其限定于实际溢出区域，避免宽屏多余的焦点停靠。
