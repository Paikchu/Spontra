import SwiftUI

struct ValuationStageView: View {
    @Environment(SpontraStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var expandedScenario: ValuationScenarioImpactDTO?
    @State private var sheetDetent: PresentationDetent = .medium

    var body: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 18) {
                CompanyInlineModeBar()

                if (store.isBootstrapping || store.isLoadingCompanyData) && store.currentValuation == nil {
                    loadingRow("正在加载 \(store.selectedTicker) 实时估值模型...")
                } else if let val = store.currentValuation {
                    valuationContent(val)
                } else {
                    emptyRow("暂未获取到 \(store.selectedTicker) 的估值报告，下拉可重试。")
                }
            }
            .padding(.horizontal, DesignTokens.Layout.horizontalPadding)
            .padding(.top, DesignTokens.Layout.topSafeClearance)
            .padding(.bottom, DesignTokens.Layout.bottomSafeClearance)
        }
        .refreshable {
            await store.loadCompanyBundle(ticker: store.selectedTicker, force: true)
        }
        .sheet(item: $expandedScenario) { scenario in
            ScenarioDetailSheet(
                ticker: store.selectedTicker,
                currency: store.currentValuation?.report?.currency ?? "USD",
                scenario: scenario,
                isExpanded: verticalSizeClass == .compact || sheetDetent == .large
            )
            .presentationDetents([.medium, .large], selection: $sheetDetent)
            .presentationDragIndicator(.visible)
            .presentationBackground(DesignTokens.Colors.canvas)
            .presentationBackgroundInteraction(.disabled)
        }
        .onChange(of: expandedScenario?.id) { _, newValue in
            if newValue != nil { sheetDetent = .medium }
        }
    }

    @ViewBuilder
    private func valuationContent(_ val: ValuationAPIResponse) -> some View {
        let report = val.report
        let currency = report?.currency ?? val.priceImpact?.currency ?? "USD"
        let quote = val.priceGuide?.quote ?? val.priceImpact?.latestQuote ?? report?.quote
        let currentPrice = quote?.price
        let scenarios = val.priceImpact?.scenarios ?? []
        let bear = scenarios.first(where: { $0.key == "bear" })?.perShare ?? report?.model?.range?.low
        let base = scenarios.first(where: { $0.key == "base" })?.perShare ?? report?.model?.range?.base
        let bull = scenarios.first(where: { $0.key == "bull" })?.perShare ?? report?.model?.range?.high

        // 1. 核心报价与情景估值（去卡片化，直接排版在画布上）
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("参考报价（\(currency)）")
                        .font(.caption2)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Text(FinanceFormat.price(currentPrice, currency: currency))
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    if let score = report?.weightedScore {
                        HStack(spacing: 4) {
                            Text("综合评分")
                                .font(.caption2)
                                .foregroundStyle(DesignTokens.Colors.textSecondary)
                            Text(String(format: "%.1f / 10", score))
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(DesignTokens.Colors.techCyan)
                        }
                    }
                    if let qDate = quote?.priceDate {
                        Text("报价日 \(qDate)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textTertiary)
                    }
                    if let asOf = report?.researchAsOf {
                        Text("研究时点 \(String(asOf.prefix(10)))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textTertiary)
                    }
                }
            }

            if let bear, let base, let bull, let currentPrice {
                ValuationRangeMeter(bear: bear, base: base, bull: bull, current: currentPrice)
            }

            // 熊 / 基准 / 牛三列排版（去背景卡片，点击仍可查看触发与证伪条件）
            if !scenarios.isEmpty {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
                    : AnyLayout(HStackLayout(spacing: 12))

                layout {
                    ForEach(scenarios) { scenario in
                        Button {
                            expandedScenario = scenario
                        } label: {
                            scenarioColumn(scenario: scenario, currentPrice: currentPrice, currency: currency)
                        }
                        .buttonStyle(LiquidGlassPressStyle())
                    }
                }
                .padding(.top, 2)
            }

            if let fv = report?.model?.fairValueRange, fv.status == "available", let low = fv.low, let high = fv.high {
                HStack(alignment: .firstTextBaseline) {
                    Text("正常经营公允区间")
                        .font(.caption2)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Spacer()
                    Text("\(FinanceFormat.price(low, currency: currency)) – \(FinanceFormat.price(high, currency: currency))")
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.financialUp)
                }
                .padding(.top, 2)
            }

            Text("注：熊 / 基准 / 牛为独立假设情景点，不代表概率分布；轻点任一情景查看触发与证伪条件。")
                .font(.caption2)
                .foregroundStyle(DesignTokens.Colors.textTertiary)
        }

        // 2. 估值核心结论摘要（纯排版 + 细分隔线）
        if let summary = report?.sections?.summary, !summary.isEmpty {
            Divider().overlay(DesignTokens.Colors.hairline)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("估值判断与价格位置")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                    Spacer()
                    if let pos = val.priceGuide?.position {
                        Text(positionLabel(pos))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(positionColor(pos))
                    }
                }

                Text(summary)
                    .font(.footnote)
                    .fontDesign(.serif)
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .lineSpacing(4)
            }
        }

        // 3. 五维度研究评分（平铺列表 + 极细进度条）
        if let dims = report?.dimensions, !dims.isEmpty {
            Divider().overlay(DesignTokens.Colors.hairline)

            VStack(alignment: .leading, spacing: 12) {
                Text("五维度研究评估")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)

                VStack(spacing: 12) {
                    ForEach(dims) { dim in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(dim.titleZh)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                                Spacer()
                                Text(String(format: "%.1f", dim.score))
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(DesignTokens.Colors.techCyan)
                            }

                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(DesignTokens.Colors.elevated)
                                    Capsule()
                                        .fill(
                                            LinearGradient(
                                                colors: [DesignTokens.Colors.techBlue, DesignTokens.Colors.techCyan],
                                                startPoint: .leading,
                                                endPoint: .trailing
                                            )
                                        )
                                        .frame(width: max(4, geo.size.width * CGFloat(min(max(dim.score / 10.0, 0), 1))))
                                }
                            }
                            .frame(height: 3.5)

                            if let rationale = dim.rationale, !rationale.isEmpty {
                                Text(rationale)
                                    .font(.caption2)
                                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                                    .lineLimit(2)
                                    .lineSpacing(2)
                            }
                        }
                    }
                }
            }
        }

        // 4. 反证与下一步核验条件（平铺排版）
        let nextChecks = val.priceImpact?.nextChecks ?? []
        let counters = val.priceImpact?.counterEvidence ?? []
        if !nextChecks.isEmpty || !counters.isEmpty {
            Divider().overlay(DesignTokens.Colors.hairline)

            VStack(alignment: .leading, spacing: 14) {
                if !counters.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("核心反证与脆弱点")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(DesignTokens.Colors.financialDown)
                        ForEach(Array(counters.prefix(3).enumerated()), id: \.offset) { _, line in
                            Text("• \(line)")
                                .font(.caption2)
                                .foregroundStyle(DesignTokens.Colors.textSecondary)
                                .lineSpacing(3)
                        }
                    }
                }

                if !nextChecks.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("关键观察条件")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(DesignTokens.Colors.textPrimary)
                        ForEach(Array(nextChecks.prefix(3).enumerated()), id: \.offset) { _, line in
                            Text("• \(line)")
                                .font(.caption2)
                                .foregroundStyle(DesignTokens.Colors.textSecondary)
                                .lineSpacing(3)
                        }
                    }
                }
            }
        }
    }

    private func scenarioColumn(
        scenario: ValuationScenarioImpactDTO,
        currentPrice: Double?,
        currency: String
    ) -> some View {
        let tint: Color = switch scenario.key {
        case "bear": DesignTokens.Colors.financialDown
        case "bull": DesignTokens.Colors.financialUp
        default: DesignTokens.Colors.textPrimary
        }

        let gapPct: Double? = {
            if let ps = scenario.perShare, let cp = currentPrice, cp > 0 {
                return ((ps - cp) / cp) * 100
            }
            if let gap = scenario.gapToReference { return gap * 100 }
            return nil
        }()

        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Text(scenario.labelZh)
                    .font(.caption2)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(DesignTokens.Colors.textTertiary)
            }
            Text(FinanceFormat.price(scenario.perShare, currency: currency))
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
            if let gapPct {
                Text(FinanceFormat.signedPercent(gapPct))
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(gapPct >= 0 ? DesignTokens.Colors.financialUp : DesignTokens.Colors.financialDown)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func positionLabel(_ pos: String) -> String {
        switch pos {
        case "below": "低于正常区间"
        case "inside": "位于正常区间"
        case "above": "高于正常区间"
        default: pos
        }
    }

    private func positionColor(_ pos: String) -> Color {
        switch pos {
        case "below": DesignTokens.Colors.financialUp
        case "above": DesignTokens.Colors.financialDown
        default: DesignTokens.Colors.techCyan
        }
    }

    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().tint(DesignTokens.Colors.techCyan)
            Text(text).font(.footnote).foregroundStyle(DesignTokens.Colors.textSecondary)
        }
        .padding(.vertical, 16)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(DesignTokens.Colors.textSecondary)
            .padding(.vertical, 16)
    }
}

struct ValuationRangeMeter: View {
    let bear: Double
    let base: Double
    let bull: Double
    let current: Double

    var body: some View {
        GeometryReader { geo in
            let lo = min(bear, current) * 0.94
            let hi = max(bull, current) * 1.04
            let span = max(hi - lo, 1)
            let xOf: (Double) -> CGFloat = { val in
                max(5, min(geo.size.width - 5, CGFloat((val - lo) / span) * geo.size.width))
            }

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(DesignTokens.Colors.elevated)
                    .frame(height: 5)

                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                DesignTokens.Colors.financialDown.opacity(0.85),
                                DesignTokens.Colors.techBlue.opacity(0.85),
                                DesignTokens.Colors.financialUp.opacity(0.9)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(8, xOf(bull) - xOf(bear)), height: 5)
                    .offset(x: xOf(bear))

                Circle()
                    .fill(DesignTokens.Colors.techCyan)
                    .frame(width: 11, height: 11)
                    .overlay(Circle().stroke(DesignTokens.Colors.canvas, lineWidth: 2))
                    .shadow(color: DesignTokens.Colors.techCyan.opacity(0.6), radius: 5)
                    .offset(x: xOf(current) - 5.5)
            }
            .frame(height: 14)
        }
        .frame(height: 14)
    }
}

struct ScenarioDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let ticker: String
    let currency: String
    let scenario: ValuationScenarioImpactDTO
    let isExpanded: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            DesignTokens.Colors.canvas.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(scenario.labelZh)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(DesignTokens.Colors.textPrimary)
                        Spacer()
                        Text(FinanceFormat.price(scenario.perShare, currency: currency))
                            .font(.title3.weight(.bold).monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.techCyan)
                    }

                    if let narrative = scenario.narrative, !narrative.isEmpty {
                        Text(narrative)
                            .font(.footnote)
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                            .lineSpacing(4)
                    }

                    if let triggers = scenario.triggers, !triggers.isEmpty {
                        Divider().overlay(DesignTokens.Colors.hairline)
                        bulletSection(title: "情景触发条件", items: triggers, tint: DesignTokens.Colors.financialUp)
                    }

                    if let invalidations = scenario.invalidation, !invalidations.isEmpty {
                        Divider().overlay(DesignTokens.Colors.hairline)
                        bulletSection(title: "情景证伪条件", items: invalidations, tint: DesignTokens.Colors.financialDown)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, isExpanded ? 64 : 22)
                .padding(.bottom, 32)
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .frame(width: 38, height: 38)
                    .liquidGlass(Circle())
            }
            .buttonStyle(LiquidGlassPressStyle())
            .accessibilityLabel("返回")
            .padding(.leading, 16)
            .padding(.top, 14)
            .opacity(isExpanded ? 1 : 0)
            .scaleEffect(isExpanded ? 1.0 : 0.84)
            .blur(radius: isExpanded ? 0 : 6)
            .allowsHitTesting(isExpanded)
        }
        .animation(DesignTokens.Motion.transitionSpring, value: isExpanded)
    }

    private func bulletSection(title: String, items: [String], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(tint)
            ForEach(Array(items.enumerated()), id: \.offset) { _, line in
                Text("• \(line)")
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .lineSpacing(3)
            }
        }
    }
}
