import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const configuredOrigin = process.env.SITE_ORIGIN || config.canonicalOrigin;
const parsedOrigin = new URL(configuredOrigin);
if (!['https:', 'http:'].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error('SITE_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.');
const origin = parsedOrigin.origin;
const assets = JSON.parse(readFileSync(new URL('../product-assets.json', import.meta.url), 'utf8'));
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const mediaPath = (src, base) => {
  if (!src) return null;
  if (!/^product\/[a-zA-Z0-9_./-]+$/.test(src) || src.includes('..')) throw new Error('Product media must use a local product/ asset path.');
  if (!existsSync(new URL('../public/' + src, import.meta.url))) throw new Error('Product media file is missing: ' + src);
  return base + src;
};
const copy = {
  en: {
    lang:'en', base:'../', title:'Spontra | Personalized AI Investment Research', category:'Investment research, built around you',
    headline:'Understands your logic.', accent:'Ready before you ask.',
    description:'Spontra follows your investment thesis, anticipates the questions that matter, and prepares answers in the format that works for you.',
    cta:'Explore the experience', product:'Product previews', nav:['Experience','Research','How it learns'], language:'中文', switch:'../', skip:'Skip to the experience',
    heroSlot:'Product walkthrough · Preview coming soon', heroSlotTitle:'Your research workspace.<br>A place for clearer decisions.', heroSlotText:'A complete product walkthrough will appear here when it is ready.',
    reserved:'Reserved for the real product', heroCaption:'Your reasoning. Public evidence. An independent view.', heroNote:'Product screens are being prepared.',
    pillars:[['Remember your reasons','Your thesis, decision conditions, and risk limits give the research its context.'],['Prepare what matters','Changes are connected to your original thinking before you come looking for them.'],['Make it clear, your way','Read the conclusion, compare evidence, or look more closely at the risk conditions.']],
    experienceKicker:'01 / Your logic, followed through', experienceTitle:'The answer starts<br>with your reasons.', experienceText:'You arrive with a history of decisions. Spontra connects new information to that history, so the research starts with what matters to you.',
    steps:[['Your original thesis','Order growth should eventually improve cash flow.'],['New evidence','Orders are growing. Cash collection is slowing.'],['The question worth reviewing','Is the quality of growth keeping up with your expectations?']],
    demoLabel:'Illustrative experience', demoNotice:'Sample reasoning, not live account data.', demoHeading:'Does this change affect my thesis?', prepared:'Prepared for you',
    modes:['Conclusion first','Compare evidence','Risk conditions'], modeNames:['summary','evidence','risk'],
    summaryEyebrow:'The conclusion', summaryTitle:'Orders have support.<br>Cash flow needs a closer look.', summaryText:'Your thesis depends on growth turning into cash. Slower collections mean that part of the thesis still needs evidence.',
    supported:'Supported', pending:'Needs evidence', diverging:'Worth reviewing', summarySignals:[['Order growth','Supported'],['Cash collection','Worth reviewing']],
    evidenceCaption:'Your expectations, compared with evidence', tableHeaders:['Expectation','New evidence','Status'], tableRows:[['Order growth','Deliveries support growth','Supported'],['Earnings quality','Further evidence needed','Unverified'],['Cash conversion','Collections slowing','Diverging']],
    riskIntro:'Use the conditions you set in advance.', riskSteps:[['Original premise','Growth improves cash flow.'],['Current gap','Collections are slowing.'],['Review condition','If the gap persists, revisit the original thesis.']],
    why:'Why this matters to you', whyText:'The example starts with the reason for investing, then preserves both supporting and contrary evidence. The open question is what to investigate next.',
    communicationKicker:'02 / A conversation in your preferred form', communicationTitle:'One question.<br>More ways to see it.', communicationText:'Sometimes you want the answer in a sentence. Sometimes you need the comparison behind it. Your preferred view changes the presentation while keeping the reasoning consistent.',
    viewDescriptions:['A short answer, with the key change and what to review next.','Your original assumptions alongside the facts that support or challenge them.','The conditions that would make you revisit your decision.'],
    viewSlot:'Product interface · Preview coming soon', viewSlotText:'The real product view will appear here.',
    researchKicker:'03 / The work behind a prepared answer', researchTitle:'Continuous research.<br>Personal relevance.', researchText:'Preparing useful answers takes more than watching a price. These four research paths keep your reasons connected to a changing world.',
    paths:[['Industry tracking','Understand the change around your holdings.','Follow supply, demand, competition, policy, and technology. Connect the change to the assumptions behind your investment.'],['Proactive risk review','Notice when evidence presses on your limits.','Review cash collection, shared exposures, and concentration. Bring contrary evidence and possible thesis breaks into view.'],['Expectation gaps','Separate what happened from what was expected.','Compare expectations with outcomes, then examine what valuation may already imply. Market expectations remain estimates to test.'],['Decision discipline','Revisit your reasons before reacting to the price.','Bring your thesis, latest evidence, and review conditions together. Distinguish changes in facts from changes in fear or excitement.']],
    learningKicker:'04 / The self-improving brain', learningTitle:'Learns how you think.<br>Keeps its own judgment.', learningText:'Your reasoning, public research, and real outcomes help refine the next round of work. Personal relevance grows alongside an independent view of the evidence.',
    learningSteps:[['Your thinking','Learn your investment reasons, trading rhythm, risk limits, and preferred way of reading.'],['Public research','Explore frameworks, industry research, and opposing views. Keep sources and test the conditions in which an idea applies.'],['Actual outcomes','Compare expectations with real results. Review what held up, what failed, and which methods need refining.']],
    learningClosing:'Understands your style.<br>Challenges your assumptions.',
    caseKicker:'A complete example, from thesis to review', caseTitle:'One investment.<br>The whole reasoning.', caseText:'A source-backed case will show the original thesis, the evidence that changed, and the conditions for reviewing the decision.', caseSlot:'Research case · Content being prepared', caseSlotText:'A complete case with dates, public sources, and review conditions belongs here.',
    caseLabels:['Original thesis','Dated evidence','Interpretation','Review condition'],
    closingKicker:'Research that remembers your reasons', closingTitle:'A clearer place<br>to think ahead.', closingText:'Explore the illustrative experience now. Product walkthroughs and real research examples will follow.', closingCta:'Explore the example', footer:'Built around your reasoning.', motion:'Pause motion', resumeMotion:'Resume motion', motionReduced:'Reduced motion enabled',
    checklistTitle:'Product content to add', checklistIntro:'Three places are ready for real product content.', checklist:['A product walkthrough: arrival, a prepared question, evidence, and view selection.','Three screenshots of the same research: conclusion, evidence comparison, and risk conditions.','A complete research case: original thesis, dated public sources, interpretation, and review condition.'],
  },
  zh: {
    lang:'zh-CN',base:'./',title:'Spontra | 理解你的交易逻辑的 AI 投资研究',category:'围绕你的交易逻辑工作的投资研究',headline:'理解你的逻辑。',accent:'先你一步，备好答案。',
    description:'Spontra 持续跟踪你的投资假设，主动发现值得关注的问题，把答案整理成你喜欢的研究界面。打开时，重要变化已准备好。',
    cta:'探索产品体验',product:'产品预览',nav:['产品体验','持续研究','如何学习'],language:'EN',switch:'./en/',skip:'跳至产品体验',
    heroSlot:'产品演示 · 内容准备中',heroSlotTitle:'你的研究工作台。<br>让每次判断更清楚。',heroSlotText:'这里将展示从主动发现问题，到查看证据的完整产品演示。',reserved:'真实产品演示预留位',heroCaption:'你的判断逻辑。公开研究证据。独立的观点。',heroNote:'产品界面正在准备中。',
    pillars:[['记住你为什么这样判断','你的投资假设、决策条件与风险边界，让每次研究都有上下文。'],['提前准备值得关注的问题','把新变化与你原来的思考连接起来，在你开始查找之前整理好答案。'],['按你的偏好，把问题讲清楚','先看结论、对照证据，或深入查看风险条件，用适合你的方式理解研究。']],
    experienceKicker:'01 / 持续跟进你的判断逻辑',experienceTitle:'答案，从你的<br>理由开始。',experienceText:'每一次打开，都带着你之前的判断。Spontra 将新信息与这些判断连接起来，从你真正关心的问题开始研究。',
    steps:[['你的原始假设','订单增长，最终应该改善现金流。'],['新出现的证据','订单仍在增长，但回款速度下降。'],['值得重新审视的问题','增长质量是否跟上了你的预期？']],
    demoLabel:'体验示意',demoNotice:'示例逻辑，不是实时账户数据。',demoHeading:'这次变化，影响我的投资逻辑吗？',prepared:'已为你整理',modes:['先看结论','对照证据','风险条件'],modeNames:['summary','evidence','risk'],
    summaryEyebrow:'先看重要结论',summaryTitle:'订单有支持。<br>现金流还需要复核。',summaryText:'你的假设是增长最终转化为现金。回款放缓，意味着这部分逻辑仍需要更多证据。',supported:'有证据支持',pending:'需要更多证据',diverging:'值得复核',summarySignals:[['订单增长','有证据支持'],['现金回收','值得复核']],
    evidenceCaption:'把预期与证据放在一起',tableHeaders:['你的预期','新证据','状态'],tableRows:[['订单增长','交付情况支持增长','有支持'],['盈利质量','仍需补充证据','待验证'],['现金转化','回款速度下降','有分歧']],
    riskIntro:'回到你提前设定的复核条件。',riskSteps:[['原始前提','增长能够改善现金流。'],['当前分歧','回款速度正在下降。'],['复核条件','如果分歧持续，重新检查原来的投资假设。']],
    why:'为什么这与你有关',whyText:'示例从你的投资理由出发，同时保留支持与反对的证据。仍未确认的问题，会成为下一步研究的重点。',
    communicationKicker:'02 / 用你喜欢的方式沟通',communicationTitle:'同一个问题。<br>多一种看清的方式。',communicationText:'有时，你只想先看一句结论。有时，你需要把证据放在一起比较。文字、表格与交互视图围绕同一个问题展开，保持一致的判断依据。',
    viewDescriptions:['先看到关键变化，以及下一步需要复核什么。','把原始假设与支持、挑战它的事实并列呈现。','看清哪些条件，会让你重新检查这次判断。'],viewSlot:'产品界面 · 内容准备中',viewSlotText:'这里将展示对应的真实产品视图。',
    researchKicker:'03 / 答案提前准备好的原因',researchTitle:'持续研究。<br>始终与你有关。',researchText:'准备有用的答案，需要持续理解变化。这四条研究路径，让你的投资理由与外部世界保持连接。',
    paths:[['行业追踪','理解持仓背后的产业变化。','跟进供需、竞争、政策与技术，把变化连接到你投资时的核心假设。'],['主动风控','发现触及假设与边界的证据。','复核现金回收、共同风险暴露与持仓集中度。主动呈现反向证据和可能失效的投资逻辑。'],['预期差研究','分清已经发生与仍在期待的事。','对照预期与实际结果，再检查估值可能隐含的市场预期。这些市场预期仍是需要验证的估计。'],['决策纪律与情绪校准','价格波动时，先重新看一遍理由。','把原始逻辑、最新证据和复核条件放在一起，帮助你分清事实变化与恐惧、兴奋带来的变化。']],
    learningKicker:'04 / 自优化大脑',learningTitle:'学会你的思考。<br>保持独立判断。',learningText:'你的思考、公开研究与真实结果，共同校正下一轮研究。逐渐理解你的同时，继续用证据检验原有观点。',
    learningSteps:[['你的思考','学习投资理由、交易节奏、风险边界，以及你喜欢的阅读方式。'],['公开研究','探索投资框架、行业研究与不同观点。保留来源，并验证每种方法适用的条件。'],['真实结果','对照预期与实际结果，复盘判断为什么成立或失效，持续修正研究方法。']],learningClosing:'理解你的风格。<br>也挑战你的假设。',
    caseKicker:'从投资假设到持续复核',caseTitle:'一次投资。<br>完整的判断过程。',caseText:'这里将用一个有来源的真实研究案例，展示原始逻辑、新证据，以及重新审视判断的条件。',caseSlot:'完整研究案例 · 内容准备中',caseSlotText:'案例将包含日期、公开资料来源与具体复核条件。',caseLabels:['原始假设','有日期的证据','变化的含义','复核条件'],
    closingKicker:'记住你的理由，持续跟进研究',closingTitle:'把下一次判断，<br>想得更清楚。',closingText:'现在可以探索体验示意。产品演示与真实研究案例将在准备好后加入。',closingCta:'查看体验示例',footer:'围绕你的判断逻辑。',motion:'暂停动画',resumeMotion:'恢复动画',motionReduced:'已减少动态效果',
    checklistTitle:'待补充的产品内容',checklistIntro:'三个位置已为真实产品内容准备好。',checklist:['一段产品演示：进入产品、查看准备好的问题、查证据、切换阅读方式。','同一份研究的三张截图：结论、证据对照、风险条件。','一个完整研究案例：原始假设、有日期的公开来源、分析含义与复核条件。'],
  }
};

for (const [locale,d] of Object.entries(copy)) {
  const isEn=locale==='en';
  const url=origin+(isEn?'/en/':'/');
  const sectionTitle=(k,t,p)=>`<p class="eyebrow">${k}</p><h2 class="section-title">${t}</h2><p class="section-description">${p}</p>`;
  const tabs=(prefix)=>d.modes.map((label,i)=>`<button type="button" role="tab" id="${prefix}-tab-${d.modeNames[i]}" aria-controls="${prefix}-panel-${d.modeNames[i]}" aria-selected="${i===0}" tabindex="${i===0?0:-1}" data-tab="${d.modeNames[i]}">${label}</button>`).join('');
  const walkthroughSrc=mediaPath(assets.walkthrough.src,d.base);
  const viewsReady=d.modeNames.every(mode=>Boolean(assets.researchViews[mode]));
  const caseReady=Boolean(assets.caseStudy.src);
  const fullyReady=Boolean(walkthroughSrc)&&viewsReady&&caseReady;
  const videoLabel=isEn?'Spontra product walkthrough':'Spontra 产品演示';
  const preparationNote=fullyReady?(isEn?'Explore the product and its research views.':'探索真实产品与研究视图。'):d.heroNote;
  const closingText=fullyReady?(isEn?'Explore the product walkthrough and follow a complete research case.':'查看产品演示，跟进一次完整的研究过程。'):d.closingText;
  const caseText=caseReady?(isEn?'Follow the original thesis, the evidence that changed, and the conditions for reviewing the decision.':'从原始逻辑到新证据，跟进重新审视判断的条件。'):d.caseText;
  const heroMedia=walkthroughSrc?`<video class="product-media" controls preload="metadata" ${assets.walkthrough.poster?`poster="${mediaPath(assets.walkthrough.poster,d.base)}"`:''} aria-label="${videoLabel}"><source src="${walkthroughSrc}" type="video/mp4"></video>`:`<div class="asset-placeholder"><span class="asset-caption">${d.reserved}</span><h2>${d.heroSlotTitle}</h2><p>${d.heroSlotText}</p></div>`;
  const viewPanels=d.modeNames.map((mode,i)=>{
    const src=mediaPath(assets.researchViews[mode],d.base);
    return `<section role="tabpanel" id="product-panel-${mode}" aria-labelledby="product-tab-${mode}" data-panel="${mode}" ${i?'hidden':''}><div class="view-panel-content">${src?`<img class="product-media" src="${src}" alt="${esc(d.modes[i])}" loading="lazy">`:`<div class="view-placeholder"><span class="asset-caption">${d.viewSlot}</span><h3>${d.modes[i]}</h3><p>${d.viewSlotText}</p></div>`}</div><p class="view-description">${d.viewDescriptions[i]}</p></section>`;
  }).join('');
  const caseSrc=mediaPath(assets.caseStudy.src,d.base);
  const html=`<!doctype html>
<html lang="${d.lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f9f6">
<meta name="description" content="${esc(d.description)}"><title>${d.title}</title>
<link rel="canonical" href="${url}"><link rel="alternate" hreflang="zh-Hans" href="${origin}/"><link rel="alternate" hreflang="en" href="${origin}/en/"><link rel="alternate" hreflang="x-default" href="${origin}/en/">
<link rel="icon" type="image/svg+xml" href="${d.base}brand/spontra-app-icon.svg"><link rel="preload" as="font" type="font/woff2" href="${d.base}design-system/fonts/Geist-Variable.woff2" crossorigin><link rel="stylesheet" href="${d.base}marketing.css">
</head><body>
<a class="skip-link" href="#experience">${d.skip}</a>
<header class="site-header wrap"><a class="brand" href="#home" aria-label="Spontra"><img src="${d.base}brand/spontra-wordmark-integrated.svg" alt="Spontra" width="142" height="43"></a><nav aria-label="${isEn?'Main navigation':'主导航'}"><a class="desktop-nav" href="#experience">${d.nav[0]}</a><a class="desktop-nav" href="#research">${d.nav[1]}</a><a class="desktop-nav" href="#learning">${d.nav[2]}</a><a class="language-link" data-language-switch href="${d.switch}" lang="${isEn?'zh-CN':'en'}">${d.language}</a><a class="nav-cta" href="#product-previews">${d.product}</a></nav></header>
<main>
<section class="hero" id="home" aria-labelledby="hero-title"><div class="hero-haze" aria-hidden="true"></div><div class="wrap"><p class="eyebrow reveal">${d.category}</p><div class="hero-copy"><h1 id="hero-title" class="reveal">${d.headline}<em>${d.accent}</em></h1><div class="hero-aside reveal"><p>${d.description}</p><div class="actions"><a class="button" href="#experience">${d.cta}</a><a class="text-link" href="#product-previews">${d.product}</a></div></div></div><div class="product-stage reveal" id="product-previews" data-asset-slot="walkthrough"><div class="product-window"><div class="window-top"><strong>Spontra</strong><span>${walkthroughSrc?d.product:d.heroSlot}</span></div>${heroMedia}</div></div><div class="hero-caption"><span>${d.heroCaption}</span><span>${preparationNote}</span></div></div></section>
<div class="promise-strip wrap">${d.pillars.map((p,i)=>`<div class="promise reveal"><span class="index">0${i+1}</span><h2>${p[0]}</h2><p>${p[1]}</p></div>`).join('')}</div>
<section class="experience section-space" id="experience" aria-labelledby="experience-title"><div class="wrap experience-grid"><div class="experience-copy reveal"><p class="eyebrow">${d.experienceKicker}</p><h2 class="section-title" id="experience-title">${d.experienceTitle}</h2><p class="section-description">${d.experienceText}</p><ol class="reason-thread">${d.steps.map((s,i)=>`<li><span class="thread-node">0${i+1}</span><div><h3>${s[0]}</h3><p>${s[1]}</p></div></li>`).join('')}</ol></div><div class="demo-area reveal"><div class="demo-note"><span>${d.demoLabel}</span><span>${d.demoNotice}</span></div><div class="answer-demo" data-tabs="answer"><div class="answer-heading"><span class="asset-caption">${d.prepared}</span><h3>${d.demoHeading}</h3></div><div class="view-tabs" role="tablist" aria-label="${isEn?'Choose your reading view':'选择阅读方式'}">${tabs('answer')}</div><div class="answer-panels"><section role="tabpanel" id="answer-panel-summary" aria-labelledby="answer-tab-summary" data-panel="summary"><p class="answer-eyebrow">${d.summaryEyebrow}</p><h4>${d.summaryTitle}</h4><p>${d.summaryText}</p><div class="signal-row">${d.summarySignals.map((s,i)=>`<div><span>${s[0]}</span><strong class="status-${i?'watch':'supported'}">${s[1]}</strong></div>`).join('')}</div></section><section role="tabpanel" id="answer-panel-evidence" aria-labelledby="answer-tab-evidence" data-panel="evidence" hidden><table><caption>${d.evidenceCaption}</caption><thead><tr>${d.tableHeaders.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${d.tableRows.map((r,i)=>`<tr><th scope="row">${r[0]}</th><td>${r[1]}</td><td><span class="status-${i===0?'supported':i===1?'pending':'watch'}">${r[2]}</span></td></tr>`).join('')}</tbody></table></section><section role="tabpanel" id="answer-panel-risk" aria-labelledby="answer-tab-risk" data-panel="risk" hidden><p class="risk-intro">${d.riskIntro}</p><ol class="risk-list">${d.riskSteps.map((s,i)=>`<li><span>0${i+1}</span><div><h4>${s[0]}</h4><p>${s[1]}</p></div></li>`).join('')}</ol></section></div><details class="why-answer"><summary>${d.why}</summary><p>${d.whyText}</p></details></div></div></div></section>
<section class="communication section-space" id="communication" aria-labelledby="communication-title"><div class="wrap"><div class="section-heading reveal"><div><p class="eyebrow">${d.communicationKicker}</p><h2 class="section-title" id="communication-title">${d.communicationTitle}</h2></div><p class="section-description">${d.communicationText}</p></div><div class="product-views reveal" data-tabs="product" data-asset-slot="researchViews"><div class="view-tabs" role="tablist" aria-label="${isEn?'Preview product views':'预览产品视图'}">${tabs('product')}</div><div class="product-view-stage">${viewPanels}</div></div></div></section>
<section class="research section-space" id="research" aria-labelledby="research-title"><div class="research-haze" aria-hidden="true"></div><div class="wrap"><div class="section-heading reveal"><div><p class="eyebrow">${d.researchKicker}</p><h2 class="section-title" id="research-title">${d.researchTitle}</h2></div><p class="section-description">${d.researchText}</p></div><div class="research-paths">${d.paths.map((p,i)=>`<details class="research-path reveal" ${i===0?'open':''}><summary><span class="index">0${i+1}</span><h3>${p[0]}</h3><span class="path-short">${p[1]}</span><span class="expand-indicator" aria-hidden="true"></span></summary><div class="path-body"><p>${p[2]}</p></div></details>`).join('')}</div></div></section>
<section class="learning section-space" id="learning" aria-labelledby="learning-title"><div class="wrap"><div class="section-heading reveal"><div><p class="eyebrow">${d.learningKicker}</p><h2 class="section-title" id="learning-title">${d.learningTitle}</h2></div><p class="section-description">${d.learningText}</p></div><div class="learning-flow">${d.learningSteps.map((s,i)=>`<div class="learning-step reveal"><span class="flow-number">0${i+1}</span><h3>${s[0]}</h3><p>${s[1]}</p></div>`).join('')}</div><p class="learning-statement reveal">${d.learningClosing}</p></div></section>
<section class="case-study section-space" id="case-study" aria-labelledby="case-title"><div class="wrap case-grid"><div class="reveal"><p class="eyebrow">${d.caseKicker}</p><h2 class="section-title" id="case-title">${d.caseTitle}</h2><p class="section-description">${caseText}</p><ol class="case-outline">${d.caseLabels.map((s,i)=>`<li><span>0${i+1}</span>${s}</li>`).join('')}</ol></div><div class="case-placeholder reveal" data-asset-slot="caseStudy">${caseSrc?`<img class="product-media" src="${caseSrc}" alt="${esc(d.caseTitle.replaceAll('<br>',' '))}" loading="lazy">`:`<span class="asset-caption">${d.caseSlot}</span><div class="case-document"><span>Spontra Research</span><span class="document-rule"></span><h3>${isEn?'The thesis.<br>The evidence.<br>The next question.':'原来的判断。<br>新的证据。<br>下一个问题。'}</h3><p>${d.caseSlotText}</p></div>`}</div></div></section>
<section class="closing" id="next-step" aria-labelledby="closing-title"><div class="closing-haze" aria-hidden="true"></div><div class="wrap closing-content reveal"><p class="eyebrow">${d.closingKicker}</p><h2 id="closing-title">${d.closingTitle}</h2><p>${closingText}</p><a class="button" href="#experience">${d.closingCta}</a><details class="content-checklist"><summary>${d.checklistTitle}</summary><p>${d.checklistIntro}</p><ol>${d.checklist.map(s=>`<li>${s}</li>`).join('')}</ol></details></div></section>
</main>
<footer><div class="wrap footer-row"><a class="footer-brand" href="#home">Spontra</a><span>${d.footer}</span><div class="footer-controls"><button type="button" id="motion-toggle" aria-pressed="false" data-pause="${d.motion}" data-resume="${d.resumeMotion}" data-reduced="${d.motionReduced}">${d.motion}</button><a data-language-switch href="${d.switch}" lang="${isEn?'zh-CN':'en'}">${d.language}</a></div></div></footer>
<script src="${d.base}marketing.js" defer></script>
</body></html>`;
  writeFileSync(new URL(isEn?'../dist/en/index.html':'../dist/index.html',import.meta.url),html);
}
writeFileSync(new URL('../dist/robots.txt',import.meta.url),`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
writeFileSync(new URL('../dist/sitemap.xml',import.meta.url),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/en/</loc></url></urlset>\n`);
console.log('Rendered Chinese and English marketing pages.');
