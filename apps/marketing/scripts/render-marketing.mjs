import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const configuredOrigin = process.env.SITE_ORIGIN || config.canonicalOrigin;
const parsedOrigin = new URL(configuredOrigin);
if (!['https:', 'http:'].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error('SITE_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.');
const origin = parsedOrigin.origin;
const assets = JSON.parse(readFileSync(new URL('../product-assets.json', import.meta.url), 'utf8'));
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const mediaPath = (src, base) => {
  if (!/^product\/[a-zA-Z0-9_./-]+$/.test(src) || src.includes('..')) throw new Error('Product media must use a local product/ asset path.');
  if (!existsSync(new URL('../public/' + src, import.meta.url))) throw new Error('Product media file is missing: ' + src);
  return base + src;
};
for (const key of ['desktop', 'mobile']) {
  const item = assets.hero?.[key];
  if (!item?.src || !Number.isInteger(item.width) || !Number.isInteger(item.height)) throw new Error(`product-assets.json hero.${key} needs src, width and height.`);
}

const copy = {
  en: {
    lang: 'en', base: '../', switch: '../', language: '中文', switchLang: 'zh-CN',
    title: 'Spontra | Your 24-hour AI investment team',
    description: 'Spontra is an AI investment team that works for you around the clock: it finds the issues that touch your holdings and writes reports shaped by your thesis, your expertise and your goals.',
    skip: 'Skip to content', navLabel: 'Main navigation', nav: ['Discovery', 'Reports'], headerCta: 'See a report',
    kicker: 'An AI investment team',
    headline: 'Spontra,', accent: 'your 24-hour investment team.',
    lede: 'A researcher tracks your industries, a risk analyst watches your limits, a reviewer hunts for counter-evidence. The team remembers why you bought, finds the issues before you ask, and writes reports shaped by your thesis, your expertise and your goals.',
    cta: 'See a report', secondary: 'How it finds issues',
    shotAlt: 'The Spontra app: a list of research reports on the left, and on the right a report on Microsoft with a one-line conclusion, the body text, sources and a comparison table',
    shotCaption: 'Spontra in use · Research reports', shotNote: 'Account figures are illustrative',
    discoverKicker: '01 / Finds the issues', discoverTitle: 'No prompt needed.<br>The issue finds you first.',
    discoverText: 'Spontra remembers why you bought, what you are waiting for and what would break the thesis. When new filings, calls or project updates arrive, it maps the evidence back to your original assumptions and surfaces what deserves a second look.',
    threadTitle: 'How one issue is found',
    thread: [['Your original thesis', 'Order growth should eventually improve cash flow.'], ['New evidence', 'Orders keep growing, but collections are slowing.'], ['The question worth reviewing', 'Is growth quality keeping up with your expectations?']],
    signalsTitle: 'Three kinds of signal it keeps looking for',
    signals: [['Supports', 'New evidence that supports your view.'], ['Counter', 'Evidence that challenges it. It goes looking, instead of agreeing with you.'], ['Open', 'Questions without an answer yet, rechecked when new disclosures arrive.']],
    quiet: 'No meaningful change, no message.',
    reportKicker: '02 / A report made for you', reportTitle: 'Same event.<br>A different report for everyone.',
    reportText: 'How deep it goes, which words it uses, what comes first and which interface it uses all depend on you. The delivery changes; the facts, sources and counter-evidence stay.',
    basedOn: 'Shaped by your', shownAs: 'Shown as',
    inputs: [['thesis', 'Why you bought, what you are waiting for, what would break it. Reports start there and cover only what touches it.'], ['expertise', 'New to investing? Plain words, with terms explained. Doing deep research? Metrics, filings and the reasoning behind them.'], ['goals', 'Long-term holding or trading around events decides what matters and what to check next.']],
    uiTitle: 'a UI built for you', uiText: 'Not just text. Beginners get animated explainers, analysts get evidence tables and trend charts, traders get event timelines.',
    vizLabel: 'Illustration: bars rise, two trend lines draw in, then timeline points appear one by one',
    closingKicker: 'Contrarian, never alone', closingTitle: 'Make your next call<br>with clearer eyes.',
    closingText: 'When you go against the crowd, someone is watching the issues for you. Every conviction comes with evidence.',
    closingCta: 'See a report', closingNote: 'Account figures in the screenshot are illustrative. Investment decisions remain yours.',
    footer: 'Built around your reasoning. Investing involves risk; decisions remain yours.',
    motion: 'Pause motion', resumeMotion: 'Resume motion', motionReduced: 'Reduced motion enabled', home: 'Spontra home',
  },
  zh: {
    lang: 'zh-CN', base: './', switch: './en/', language: 'EN', switchLang: 'en',
    title: 'Spontra | 24 小时只为你的 AI 投资团队',
    description: 'Spontra 是一支 24 小时只为你工作的 AI 投资团队：主动发现与你持仓相关的问题，按你的投资逻辑、知识水平和目标写成专属报告。',
    skip: '跳至正文', navLabel: '主导航', nav: ['主动发现', '专属报告'], headerCta: '查看报告示例',
    kicker: '一支 AI 投资团队',
    headline: 'Spontra，', accent: '24 小时只为你。',
    lede: '研究员追踪行业，风控盯住边界，复核员专找反证。这支团队记住你为什么买入，在你开口之前发现问题，再按你的投资逻辑、知识水平和目标写成报告。',
    cta: '查看报告示例', secondary: '它怎么发现问题',
    shotAlt: 'Spontra 实际界面：左侧为研究汇报列表，右侧为一份关于微软的研究汇报，包含一句话结论、正文、依据与数据对照表',
    shotCaption: 'Spontra 实际界面 · 研究汇报', shotNote: '账户数字为示意',
    discoverKicker: '01 / 主动发现问题', discoverTitle: '不用你开口，<br>问题先被发现。',
    discoverText: 'Spontra 记住你为什么买入、在等待什么、什么情况会让判断失效。新的财报、电话会、项目进展出现时，它把证据放回你的原始假设，先找出值得复核的问题。',
    threadTitle: '一个问题是怎么被发现的',
    thread: [['你的原始假设', '订单增长，最终应该改善现金流。'], ['新出现的证据', '订单仍在增长，但回款速度下降。'], ['值得重新审视的问题', '增长质量是否跟上了你的预期？']],
    signalsTitle: '它持续在找三类信号',
    signals: [['支持', '支持你判断的新证据。'], ['反证', '挑战你判断的证据。它会主动去找，而不是只附和你。'], ['待确认', '还没有结论的问题。新的披露出现后，再次核验。']],
    quiet: '没有重要变化时，不发消息。',
    reportKicker: '02 / 为你定制的报告', reportTitle: '同一件事，<br>每人一份报告。',
    reportText: '讲到多深、用什么词、先看什么、用什么界面呈现，都按你来。变的是讲法与形式；事实、来源与反证，一条不少。',
    basedOn: '按你的', shownAs: '呈现成',
    inputs: [['投资逻辑', '你为什么买入、在等待什么、什么情况会让判断失效。报告从这些前提出发，只讲与它们有关的变化。'], ['知识水平', '刚入门，就用大白话并解释术语；做专业研究，就直接给指标、原文和推导。'], ['投资目标', '长期持有还是阶段交易，决定什么算重要、下一步该看什么。']],
    uiTitle: '专属的界面', uiText: '不只是文字。入门读者看到动态图解，专业读者拿到证据表和趋势图，交易者看到事件时间线。',
    vizLabel: '示意：柱状图、趋势线与时间线依次出现',
    closingKicker: '逆向而行，不必独行', closingTitle: '把下一次判断，<br>想得更清楚。',
    closingText: '逆向而行时，有人替你盯着问题。每一次确信，都有证据可查。',
    closingCta: '查看报告示例', closingNote: '截图中的账户数字为示意。投资判断由你确认。',
    footer: '围绕你的判断逻辑。投资有风险，判断由你确认。',
    motion: '暂停动画', resumeMotion: '恢复动画', motionReduced: '已减少动态效果', home: 'Spontra 首页',
  },
};

const mark = (w, h) => `<svg width="${w}" height="${h}" viewBox="11.5 3 24.5 42" aria-hidden="true"><path d="M32.693 12.671 A9 9 0 1 0 24 24 A9 9 0 1 1 21.671 41.693" fill="none" stroke="currentColor" stroke-width="5"/><circle cx="16.368" cy="37.769" r="4.4" fill="#a4bdff"/></svg>`;
const arrow = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const evidenceIcon = {
  support: '<svg class="evidence" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="var(--evidence-support)"/></svg>',
  counter: '<svg class="evidence" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 11.2 10.6H.8Z" fill="var(--evidence-counter)"/></svg>',
  pending: '<svg class="evidence" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.75" fill="none" stroke="var(--evidence-pending)" stroke-width="1.5" stroke-dasharray="2.2 2"/></svg>',
};
const signalKinds = ['support', 'counter', 'pending'];
const threadKinds = ['support', 'counter', 'accent'];
const viz = (label) => `<svg class="viz" viewBox="0 0 240 56" role="img" aria-label="${esc(label)}">
<rect class="bar" x="0" y="30" width="10" height="22" rx="2" style="--d:300ms"/><rect class="bar" x="14" y="22" width="10" height="30" rx="2" style="--d:370ms"/><rect class="bar" x="28" y="12" width="10" height="40" rx="2" style="--d:440ms"/><rect class="bar is-counter" x="42" y="34" width="10" height="18" rx="2" style="--d:510ms"/>
<path class="draw" pathLength="1" d="M76 46C96 40 108 22 126 24S150 10 160 8" style="--d:600ms"/><path class="draw is-counter" pathLength="1" d="M76 20C96 22 110 30 126 34S150 44 160 46" style="--d:700ms"/>
<path class="draw is-axis" pathLength="1" d="M180 30H236" style="--d:900ms"/><circle class="pop" cx="184" cy="30" r="4" style="--d:1000ms"/><circle class="pop is-counter" cx="206" cy="30" r="4" style="--d:1080ms"/><circle class="pop is-open" cx="230" cy="30" r="4.5" style="--d:1160ms"/>
</svg>`;

for (const [locale, d] of Object.entries(copy)) {
  const isEn = locale === 'en';
  const url = origin + (isEn ? '/en/' : '/');
  const { desktop, mobile } = assets.hero;
  const sectionHead = (id, kicker, title, text) => `<div class="section-head reveal"><div><p class="kicker">${kicker}</p><h2 class="display-1" id="${id}">${title}</h2></div><p class="lead">${text}</p></div>`;
  const html = `<!doctype html>
<html lang="${d.lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d1718"><meta name="color-scheme" content="dark">
<meta name="description" content="${esc(d.description)}"><title>${esc(d.title)}</title>
<link rel="canonical" href="${url}"><link rel="alternate" hreflang="zh-Hans" href="${origin}/"><link rel="alternate" hreflang="en" href="${origin}/en/"><link rel="alternate" hreflang="x-default" href="${origin}/en/">
<meta property="og:title" content="${esc(d.title)}"><meta property="og:description" content="${esc(d.description)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${origin}/${desktop.src}">
<link rel="icon" type="image/svg+xml" href="${d.base}brand/spontra-app-icon.svg">
<link rel="preload" as="font" type="font/woff2" href="${d.base}design-system/fonts/Geist-Variable.woff2" crossorigin><link rel="preload" as="font" type="font/woff2" href="${d.base}design-system/fonts/Newsreader-Variable.woff2" crossorigin>
<link rel="stylesheet" href="${d.base}design-system/tokens/tokens.css"><link rel="stylesheet" href="${d.base}marketing.css">
</head><body>
<a class="skip-link" href="#discover">${d.skip}</a>
<header class="site-header"><div class="wrap header-row"><a class="brand" href="#home" aria-label="${d.home}">${mark(17, 29)}<span>Spontra</span></a><nav aria-label="${d.navLabel}"><a class="nav-link desktop-only" href="#discover">${d.nav[0]}</a><a class="nav-link desktop-only" href="#report">${d.nav[1]}</a><a class="nav-link" data-language-switch href="${d.switch}" lang="${d.switchLang}">${d.language}</a><a class="btn btn-ghost" href="#report">${d.headerCta}</a></nav></div></header>
<main>
<section class="hero" id="home" aria-labelledby="hero-title"><div class="glow glow-accent" aria-hidden="true"></div><div class="glow glow-brand" aria-hidden="true"></div><div class="wrap">
<p class="kicker rise" style="--d:0ms"><span class="dot" aria-hidden="true"></span>${d.kicker}</p>
<h1 id="hero-title"><span class="rise" style="--d:70ms">${d.headline}</span><span class="rise is-accent" style="--d:140ms">${d.accent}</span></h1>
<p class="lead hero-lede rise" style="--d:210ms">${d.lede}</p>
<div class="actions rise" style="--d:280ms"><a class="btn btn-primary" href="#report">${d.cta}<span class="node" aria-hidden="true"></span></a><a class="text-link" href="#discover">${d.secondary}${arrow}</a></div>
<figure class="hero-shot rise" style="--d:360ms"><div class="shot-frame"><picture><source media="(max-width: 720px)" srcset="${mediaPath(mobile.src, d.base)}" width="${mobile.width}" height="${mobile.height}"><img src="${mediaPath(desktop.src, d.base)}" width="${desktop.width}" height="${desktop.height}" alt="${esc(d.shotAlt)}" fetchpriority="high"></picture></div><figcaption><span>${d.shotCaption}</span><span>${d.shotNote}</span></figcaption></figure>
</div></section>

<section class="section" id="discover" aria-labelledby="discover-title"><div class="wrap stack">
${sectionHead('discover-title', d.discoverKicker, d.discoverTitle, d.discoverText)}
<div class="split">
<div class="reveal"><p class="kicker block-title">${d.threadTitle}</p><ol class="thread">${d.thread.map((s, i) => `<li class="is-${threadKinds[i]}">${threadKinds[i] === 'counter' ? evidenceIcon.counter : '<span class="thread-dot" aria-hidden="true"></span>'}<div><span class="caption">${s[0]}</span><strong>${s[1]}</strong></div></li>`).join('')}</ol></div>
<div class="reveal" style="--d:70ms"><p class="kicker block-title">${d.signalsTitle}</p><ul class="signals">${d.signals.map((s, i) => `<li>${evidenceIcon[signalKinds[i]]}<span class="signal-label is-${signalKinds[i]}">${s[0]}</span><span>${s[1]}</span></li>`).join('')}</ul></div>
</div>
<p class="quiet reveal"><span class="dot is-accent" aria-hidden="true"></span>${d.quiet}</p>
</div></section>

<section class="section" id="report" aria-labelledby="report-title"><div class="wrap stack">
${sectionHead('report-title', d.reportKicker, d.reportTitle, d.reportText)}
<ol class="inputs">${d.inputs.map((s, i) => `<li class="reveal" style="--d:${i * 70}ms"><span class="caption">${d.basedOn}</span><h3>${s[0]}</h3><p>${s[1]}</p></li>`).join('')}<li class="reveal is-ui" style="--d:210ms"><span class="caption">${d.shownAs}</span><h3>${d.uiTitle}</h3><p>${d.uiText}</p>${viz(d.vizLabel)}</li></ol>
</div></section>

<section class="closing" aria-labelledby="closing-title"><div class="glow glow-closing" aria-hidden="true"></div><div class="wrap closing-content reveal">
<p class="kicker">${d.closingKicker}</p><h2 id="closing-title">${d.closingTitle}</h2><p class="lead">${d.closingText}</p>
<a class="btn btn-primary" href="#report">${d.closingCta}<span class="node" aria-hidden="true"></span></a><p class="caption">${d.closingNote}</p>
</div></section>
</main>
<footer class="site-footer"><div class="wrap footer-row"><div class="footer-brand"><a class="brand is-small" href="#home" aria-label="${d.home}">${mark(12, 21)}<span>Spontra</span></a><span class="caption">${d.footer}</span></div><div class="footer-controls"><button type="button" class="pill-button" id="motion-toggle" aria-pressed="false" data-pause="${d.motion}" data-resume="${d.resumeMotion}" data-reduced="${d.motionReduced}">${d.motion}</button><a class="nav-link" data-language-switch href="${d.switch}" lang="${d.switchLang}">${d.language}</a></div></div></footer>
<script src="${d.base}marketing.js" defer></script>
</body></html>`;
  writeFileSync(new URL(isEn ? '../dist/en/index.html' : '../dist/index.html', import.meta.url), html);
}
writeFileSync(new URL('../dist/robots.txt', import.meta.url), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
writeFileSync(new URL('../dist/sitemap.xml', import.meta.url), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/en/</loc></url></urlset>\n`);
console.log('Rendered Chinese and English marketing pages.');
