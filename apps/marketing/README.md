# Spontra 官网

官网的唯一维护源码位于本目录，与投资应用共用 `Paikchu/Spontra` 仓库。
迁入版本来自 Sites 官网 v42（源提交 `c002d074c39509c39dfd2e4c549f55fbb32c8708`）。
原 Sites 目录保留为迁移前备份；此后修改本目录，不再维护两个版本。

## 产品观点

官网与 [项目产品理念](../../docs/product-vision.md)共用两个核心目标：理解交易逻辑、提前准备答案；按用户偏好用文字和丰富 UI 沟通。行业追踪、主动风控、预期差、决策纪律与自优化大脑是实现路径。后续文案与产品素材更新应同时核对项目文档，并区分目标、示意与真实能力。

## 本地维护

在仓库根目录运行：

```sh
npm run marketing:dev
```

预览地址为 `http://localhost:8788/`，英文版为 `/en/`。
修改源码后重启此命令重新生成页面；这是实际 Workers 静态资源本地预览。

- `scripts/render-marketing.mjs`：中英文文案、HTML 结构和素材插入位置。
- `public/marketing.css`：样式、响应式布局和渐变动画。
- `public/marketing.js`：视图切换、动画暂停与语言切换。
- `public/brand/`、`public/design-system/`：品牌资源与字体。
- `public/product/`、`product-assets.json`：真实产品素材及其映射。
- `site.config.json`：默认 canonical 域名。
- `dist/`：构建产物，不提交、不手工修改。

构建：`npm run marketing:build`。检查打包：`npm run marketing:check`，只执行 dry-run，不发布。
不需要安装另一个项目的依赖；直接复用仓库内 Wrangler。
静态资源由 Cloudflare 直接提供，不需要 Worker 脚本、数据库或业务凭据。
`/en` 自动跳转 `/en/`，不存在的地址返回 404，不返回首页。

## 域名与 SEO

构建时 `SITE_ORIGIN` 优先于 `site.config.json`，一次更新中英文 canonical、hreflang、robots 和 sitemap。
配置值必须为完整 origin，例如 `https://example.com`，不可包含路径或查询参数。
默认值为官网 Worker 的 workers.dev 地址。以后绑定正式域名时同步更新配置。

## 自动发布

官网已接入现有主应用的 Cloudflare Git 构建，由根目录 `scripts/deploy-cloudflare-ci.mjs` 调用 `marketing:deploy:ci`，创建或更新独立的 `spontra-marketing` Worker。

每次推送 `origin/main`，现有主应用构建先生成并验证官网资源，再发布主应用、sec-cron、业务地图与官网。财报 Pipeline 继续由原独立构建发布。
无需新增 Git 远程或另建一个 Cloudflare 构建触发器。
官网没有 D1、Service Binding 或运行时 Secrets；发布子进程移除主应用的 Worker 名称覆盖变量，防止覆盖主应用。

生产地址：`https://spontra-marketing.max-zhangyuchen.workers.dev/`，英文版：`/en/`。
正式域名配置保存在 `site.config.json`，CI 可用 `SITE_ORIGIN` 覆盖。默认无需新增构建变量。
绑定自定义域名时，将对应 custom-domain route 加入此目录的 `wrangler.jsonc`，同步修改 canonical origin，随后经 main 自动发布。

本地不得手动部署或直接调用发布 API。用户要求上线后，遵循根目录 AGENTS.md：验证、仅提交任务修改、合并 main、push origin main、核验该提交自动构建和线上页面。
原有 Sites 地址作为旧版保留，后续源码只在本仓库维护。

## 产品内容

见 [PRODUCT-CONTENT.md](./PRODUCT-CONTENT.md)。图片、视频放入 `public/product/`，填写 `product-assets.json` 后重新构建。
构建会检查已配置素材是否存在；素材未准备好时继续显示明确的预留位。

参考：[Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[HTML 路由](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)。
