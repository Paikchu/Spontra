# 视觉复核标识契约：五种固定响应的本地验收

本轮仅收尾 QA 标识契约和后续回执的可追溯性，不修改报告 HTML/CSS、评分阈值或报告生成流程，也不新增重试、重渲染或恢复 API。用户已要求保持当前报告状态；本次没有提交、部署、真实模型调用或生产写入。

当前生产事实由父任务另行核实：CRWV correction 已通过 summary/content 和完整语义复核，随后 render 在累计新 3 + 旧 7 = 10/12 时因未知 block/viewport 标识失败，保存的五项评分为 `5/6/6/8/5`，加权仅 59。该稿未成为新的 validated/published 版本；旧响应中的原始 issues 当时未保存，本补丁无法回填。即使单独修正标识，59 分仍不满足质量门槛。用户暂停了布局调整与真实复审，剩余两次审核额度未使用。本地结果不代表这份真实报告通过或已修复视觉质量。

## 执行与证据

```bash
SPONTRA_VISUAL_REVIEW_CONTRACT_ACCEPTANCE=1 \
  node scripts/filing-operator-completion-acceptance.mjs
```

最终执行时间为 `2026-11-17T06:12:11.544Z`，进程 exit 0，**56/56 项通过**。独立 [结果文件](results/filing-visual-review-contract.json) SHA-256 为 `5c7fb4b6fe54caf83c1421783f59c29491eeed9f9ac6e3e0ac323c3b1bb6b748`。未覆盖或重跑历史 171、47、54、72 项结果。

验收使用 [现有本地操作旅程](../../../scripts/filing-operator-completion-acceptance.mjs) 的单独 flag：实际同源 proxy → 命名 AdminGateway → 实际 TaskRunner → 实际工具及 composer 的 prepare、六章 content、完整 semantic、strict render。QA 通过真实 Chromium/CDP 打开实际 ArtifactFrame 和 artifact-frame；本地外壳为固定侧栏，未冒称完整生产页面。报告 HTML、材料及所有模型 HTTP 响应均为固定合成数据，没有启动作者模型、伪造通过回执或代替用户签核。

总计 40 次合成 provider HTTP（30 content、5 semantic、5 visual）、90 张真实浏览器截图；真实模型调用、生产访问及发布均为 0。每例实际测量六个 block，分别在 `1440x900 light`、`390x844 light`、`1280x800 dark` 三视口截图并发送共 18 张图，均只发一次 visual HTTP，无重试。

首轮 fixture 存在重复定义及 major 场景期望 viewport 不一致，断言失败并完成清理，未生成结果文件；修正后仅实际重跑上述五例，最终统计仅来自该次 exit 0 执行。

## 五种固定响应

| 场景 | 固定响应 | 实际结果 |
| --- | --- | --- |
| 请求契约及正向样例 | 五项均 9，90 分，无 issues | 动态 schema 枚举为实际六章 ID 和三种完整视口名；提示词列出相同集合，禁止 all、`*`、别名和组合标识；validated shadow |
| 非法标识 | 90 分；四条 issues，其中三条含非法 block 或 viewport | failed；原始四条 issues 全部保留，三个非法位置及原值分别记录；`visualIdentifiersValid=false`、`visualReviewed=false`，未映射或丢弃原始标识 |
| 低分 | 合法标识；`5/6/6/8/5`，59 分，无 issues | 复核响应已完成，但 composer 严格失败，不能成为 validated shadow |
| 重大问题 | 合法标识；五项均 9，90 分，一条 major | major 的真实 block/viewport 进入问题记录，严格失败 |
| 合法高分 | 合法标识；`8/9/8/8/9`，84 分，无 issues | 全视口覆盖，validated shadow |

每例均捕获**实际发出的** JSON schema、system prompt、截图 blockMap，并核对实际 provider payload；不是单独调用 schema 工厂。完整 parsed `visualVerdict` 同时从实际 composer render receipt 和 `analysis_artifact_checks` 持久记录读回，与合成响应逐字结构比较。非法位置记录保留原始 issue 下标、block、viewport 以及各自的 unknown 标记，没有将未知标识改写成某个合法章节。

两个本地通过样例只产生未发布 shadow；三个失败样例均不暴露 validated preview。隔离库公开指针始终为原 v6 及原哈希，没有执行 promote。

## 范围与限制

本轮只验证后续 QA 的请求契约、parsed 原始回复保全及严格门槛。权重仍为布局/层级各 25%、密度 20%、一致性/可读性各 15%，总分至少 80，且每项至少 7；major、缺视口和未知标识的拒绝条件未放宽。

结果保存了执行时 [qa.ts](../../../workers/analysis/src/artifact/qa.ts) 和 [compose.ts](../../../workers/analysis/src/artifact/compose.ts) 的 SHA-256，以及截图文件路径、大小和哈希。`node --check`、脚本 ESLint、Markdown 相对链接/围栏和 `git diff --check` 均通过。生产两文件的 Analysis 类型检查及 ESLint 由父任务完成并单独记录。

没有验证真实视觉模型的判断质量、真实 CRWV 新布局或重新复核，也未补造历史原始 issues。截图测量与回执通过不能替代真实报告的阅读质量验收。
