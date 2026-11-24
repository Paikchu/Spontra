import SwiftUI

struct CompanyStatementsStageView: View {
    let ticker: String
    @State private var statement: FinancialStatement = .income

    var body: some View {
        CompanyStatementContent(ticker: ticker, statement: $statement)
            .id(ticker)
    }
}

private struct CompanyStatementContent: View {
    @Environment(SpontraStore.self) private var store
    let ticker: String
    @Binding var statement: FinancialStatement
    @State private var selections: [FinancialStatement: String] = [:]
    @State private var income: LoadState<[StatementPeriod]> = .loading
    @State private var capital: LoadState<CapitalStatementPublication.Periods> = .loading

    private enum LoadState<Value> {
        case loading
        case loaded(Value)
        case failed

        func map<T>(_ transform: (Value) -> T) -> LoadState<T> {
            switch self {
            case .loading: .loading
            case .loaded(let value): .loaded(transform(value))
            case .failed: .failed
            }
        }
    }

    private var current: LoadState<[StatementPeriod]> {
        switch statement {
        case .income: income
        case .balance: capital.map(\.balance)
        case .cash: capital.map(\.cash)
        }
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 16) {
                CompanyInlineModeBar()

                Picker("财务报表", selection: $statement) {
                    ForEach(FinancialStatement.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)

                switch current {
                case .loading:
                    ProgressView()
                        .tint(DesignTokens.Colors.techCyan)
                        .accessibilityLabel("正在加载\(statement.label)")
                        .frame(maxWidth: .infinity, minHeight: 124)
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(statement.label)加载失败")
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                        Button("重试") {
                            Task {
                                switch statement {
                                case .income:
                                    income = .loading
                                    await loadIncome(refresh: true)
                                case .balance, .cash:
                                    capital = .loading
                                    await loadCapital(refresh: true)
                                }
                            }
                        }
                        .tint(DesignTokens.Colors.techCyan)
                    }
                    .font(.footnote)
                    .padding(.vertical, 20)
                case .loaded(let periods):
                    if let period = periods.first(where: { $0.id == selections[statement] }) ?? periods.first {
                        statementHeader(period, periods: periods)
                        ForEach(period.flows.indices, id: \.self) { index in
                            if index > 0 {
                                Divider().overlay(DesignTokens.Colors.hairline)
                            }
                            StatementSankeyView(flow: period.flows[index], currency: period.currency)
                        }
                        sourceLinks(period.sources)
                    } else {
                        Text("暂无可用的\(statement.label)数据")
                            .font(.footnote)
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                            .padding(.vertical, 20)
                    }
                }
            }
            .padding(.horizontal, DesignTokens.Layout.horizontalPadding)
            .padding(.top, DesignTokens.Layout.topSafeClearance)
            .padding(.bottom, DesignTokens.Layout.bottomSafeClearance)
        }
        .task { await loadIncome(refresh: false) }
        .task { await loadCapital(refresh: false) }
        .refreshable {
            async let incomeLoad: Void = loadIncome(refresh: true)
            async let capitalLoad: Void = loadCapital(refresh: true)
            _ = await (incomeLoad, capitalLoad)
        }
    }

    private func statementHeader(_ period: StatementPeriod, periods: [StatementPeriod]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(period.headline)
                        .font(.caption)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Text(period.amount)
                        .font(.title2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                }
                .accessibilityElement(children: .combine)

                Spacer(minLength: 0)

                Menu {
                    ForEach(periods) { entry in
                        Button {
                            selections[statement] = entry.id
                        } label: {
                            if entry.id == period.id {
                                Label(entry.periodLabel, systemImage: "checkmark")
                            } else {
                                Text(entry.periodLabel)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(period.periodLabel).monospacedDigit()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 10)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .foregroundStyle(DesignTokens.Colors.techCyan)
                .accessibilityLabel("财期")
                .accessibilityValue(period.periodLabel)
            }

            let date = FinanceFormat.dotDate(period.periodEnd)
            Text(period.periodLabel == date
                 ? "\(period.basis) · \(period.currency)"
                 : "\(date) · \(period.basis) · \(period.currency)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(DesignTokens.Colors.textSecondary)

            Divider().overlay(DesignTokens.Colors.hairline)

            if statement != .income {
                HStack {
                    Text(statement == .cash ? "现金来源" : "资金来源")
                    Spacer()
                    Text(statement == .cash ? "现金去向" : "资产及权益抵减")
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(DesignTokens.Colors.textSecondary)
            }
        }
    }

    private func sourceLinks(_ sources: [URL]) -> some View {
        ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
            Link(destination: source) {
                Label(sources.count == 1 ? "SEC 原始披露" : "SEC 原始披露 \(index + 1)",
                      systemImage: "arrow.up.right")
                    .font(.footnote)
                    .frame(minHeight: 44)
            }
            .foregroundStyle(DesignTokens.Colors.techCyan)
        }
    }

    private func loadIncome(refresh: Bool) async {
        do {
            let periods = try await store.incomeStatements(ticker: ticker, refresh: refresh)
            if !Task.isCancelled { income = .loaded(periods) }
        } catch {
            if !Task.isCancelled { income = .failed }
        }
    }

    private func loadCapital(refresh: Bool) async {
        do {
            let periods = try await store.capitalStatements(ticker: ticker, refresh: refresh)
            if !Task.isCancelled { capital = .loaded(periods) }
        } catch {
            if !Task.isCancelled { capital = .failed }
        }
    }
}

private struct StatementSankeyView: View {
    let flow: StatementSankey
    let currency: String
    @ScaledMetric(relativeTo: .caption2) private var labelHeight: CGFloat = 37

    private struct Row: Identifiable {
        let id: Int
        let label: String
        let amount: String
        let tone: StatementSankey.Tone
        let center: CGFloat
        let poolStart: CGFloat
        let thickness: CGFloat
    }

    var body: some View {
        let count = max(flow.sources.count, flow.uses.count)
        let poolHeight = min(CGFloat(count) * 16 + 12, 125)
        let height = labelHeight * CGFloat(count) + poolHeight
        let sources = rows(flow.sources, height: height, poolHeight: poolHeight)
        let uses = rows(flow.uses, height: height, poolHeight: poolHeight)

        GeometryReader { geometry in
            let labelWidth = geometry.size.width * 0.31
            ZStack {
                Canvas { context, size in
                    let nodeWidth: CGFloat = 3
                    let start = labelWidth + 6
                    let center = size.width / 2
                    let end = size.width - start
                    for row in sources {
                        draw(row, from: start, to: center, atSource: true, context: context, nodeWidth: nodeWidth)
                    }
                    for row in uses {
                        draw(row, from: center, to: end, atSource: false, context: context, nodeWidth: nodeWidth)
                    }
                    let spine = CGRect(x: center - 1.5, y: (height - poolHeight) / 2, width: 3, height: poolHeight)
                    context.fill(Path(spine), with: .color(DesignTokens.Colors.textSecondary.opacity(0.52)))
                }
                .accessibilityHidden(true)

                HStack(spacing: 0) {
                    labels(sources, alignment: .leading, width: labelWidth, height: height)
                    Spacer(minLength: 0)
                    labels(uses, alignment: .trailing, width: labelWidth, height: height)
                }
            }
        }
        .frame(height: height)
    }

    private func rows(_ nodes: [StatementSankey.Node], height: CGFloat, poolHeight: CGFloat) -> [Row] {
        let scale = poolHeight / flow.total
        let total = nodes.reduce(0) { $0 + abs($1.amount) } * scale
        let spacing = (height - total) / CGFloat(nodes.count)
        var plotY = (height - total) / 2
        var labelY = spacing / 2

        return nodes.enumerated().map { index, node in
            let thickness = abs(node.amount) * scale
            let row = Row(id: index, label: node.label, amount: FinanceFormat.compactMoney(node.amount, currency: currency),
                          tone: node.tone, center: labelY + thickness / 2, poolStart: plotY, thickness: thickness)
            labelY += thickness + spacing
            plotY += thickness
            return row
        }
    }

    private func labels(_ rows: [Row], alignment: HorizontalAlignment, width: CGFloat, height: CGFloat) -> some View {
        ZStack(alignment: .top) {
            ForEach(rows) { row in
                VStack(alignment: alignment, spacing: 2) {
                    Text(row.label)
                        .font(.caption2)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                        .lineLimit(2)
                    Text(row.amount)
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
                .frame(width: width, alignment: alignment == .leading ? .leading : .trailing)
                .position(x: width / 2, y: row.center)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(row.label) \(row.amount)")
            }
        }
        .frame(width: width, height: height)
    }

    private func draw(_ row: Row, from: CGFloat, to: CGFloat, atSource: Bool,
                      context: GraphicsContext, nodeWidth: CGFloat) {
        let edgeY = row.center - row.thickness / 2
        let leftY = atSource ? edgeY : row.poolStart
        let rightY = atSource ? row.poolStart : edgeY
        let middle = (from + to) / 2
        let depth = row.thickness
        let color = switch row.tone {
        case .primary: DesignTokens.Colors.techCyan
        case .funding: DesignTokens.Colors.financialUp
        case .spending: DesignTokens.Colors.financialDown
        case .other: DesignTokens.Colors.financialShift
        }

        var band = Path()
        band.move(to: CGPoint(x: from, y: leftY))
        band.addCurve(to: CGPoint(x: to, y: rightY),
                      control1: CGPoint(x: middle, y: leftY), control2: CGPoint(x: middle, y: rightY))
        band.addLine(to: CGPoint(x: to, y: rightY + depth))
        band.addCurve(to: CGPoint(x: from, y: leftY + depth),
                      control1: CGPoint(x: middle, y: rightY + depth), control2: CGPoint(x: middle, y: leftY + depth))
        band.closeSubpath()
        context.fill(band, with: .color(color.opacity(0.33)))

        let marker = CGRect(x: atSource ? from - nodeWidth : to, y: row.center - max(2, depth) / 2,
                            width: nodeWidth, height: max(2, depth))
        context.fill(Path(marker), with: .color(color))
    }
}
