import SwiftUI

struct CompanyStreamStageView: View {
    @Environment(SpontraStore.self) private var store
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var enabledCategories: Set<StreamFilterCategory> = [.reports, .management]
    @State private var selectedItem: CompanyStreamItem?
    @State private var sheetDetent: PresentationDetent = .medium

    var body: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 14) {
                CompanyInlineModeBar()

                // 1. 公司核心数据条（去卡片化，直接平铺于画布，用细分隔线界定层次）
                if let company = store.selectedCompany {
                    companyOverviewSection(company)
                    Divider().overlay(DesignTokens.Colors.hairline)
                }

                // 2. 多选过滤胶囊：✓ 财报 | ✓ 管理层动态（紧凑尺寸）
                HStack(spacing: 8) {
                    ForEach(StreamFilterCategory.allCases) { category in
                        let isOn = enabledCategories.contains(category)
                        Button {
                            toggleCategory(category)
                        } label: {
                            HStack(spacing: 4) {
                                if isOn {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 10, weight: .bold))
                                }
                                Text(category.label)
                                    .font(.caption.weight(.medium))
                            }
                            .foregroundStyle(
                                isOn
                                    ? DesignTokens.Colors.textPrimary
                                    : DesignTokens.Colors.textSecondary
                            )
                            .padding(.horizontal, 12)
                            .frame(height: 30)
                            .liquidGlass(
                                Capsule(),
                                tint: isOn ? DesignTokens.Colors.techBlue.opacity(0.32) : nil
                            )
                        }
                        .buttonStyle(LiquidGlassPressStyle())
                    }
                    Spacer()
                }
                .padding(.top, 2)

                // 3. 按网页同款时间线渲染：同财季定期财报与业绩 8-K 成组，其余事件按披露日倒序排列
                if (store.isBootstrapping || store.isLoadingCompanyData) && store.currentStreamBlocks.isEmpty {
                    loadingRow("正在同步 \(store.selectedTicker) 财报与管理层动态...")
                } else if store.currentStreamBlocks.isEmpty {
                    emptyRow(store.companyError ?? "暂无 \(store.selectedTicker) 的最新申报记录，下拉重试。")
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(store.currentStreamBlocks) { block in
                            switch block {
                            case .quarter(_, let heading, let periodEnd, let items):
                                let visible = items.filter { enabledCategories.contains($0.category) }
                                if !visible.isEmpty {
                                    quarterSectionView(
                                        quarterHeading: heading,
                                        periodEndLabel: periodEnd,
                                        items: visible
                                    )
                                    Divider()
                                        .overlay(DesignTokens.Colors.hairline)
                                        .padding(.top, 4)
                                }
                            case .standalone(let item):
                                if enabledCategories.contains(item.category) {
                                    streamItemRow(item)
                                    Divider()
                                        .overlay(DesignTokens.Colors.hairline)
                                        .padding(.leading, 28)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, DesignTokens.Layout.horizontalPadding)
            .padding(.top, DesignTokens.Layout.topSafeClearance)
            .padding(.bottom, DesignTokens.Layout.bottomSafeClearance)
        }
        .refreshable {
            await store.loadCompanyBundle(ticker: store.selectedTicker, force: true)
        }
        .overlay(alignment: .bottom) {
            // iOS 26/27 悬浮 Sheet 底部有微弱圆角间隙，弹窗开启时遮蔽最底缘避免底层文字漏出
            DesignTokens.Colors.canvas
                .frame(height: 44)
                .ignoresSafeArea(edges: .bottom)
                .opacity(selectedItem != nil ? 1 : 0)
                .animation(.easeOut(duration: 0.18), value: selectedItem != nil)
                .allowsHitTesting(false)
        }
        .sheet(item: $selectedItem) { item in
            CompanyStreamDetailSheet(
                ticker: store.selectedTicker,
                item: item,
                isExpanded: verticalSizeClass == .compact || sheetDetent == .large
            )
            .environment(store)
            .presentationDetents([.medium, .large], selection: $sheetDetent)
            .presentationDragIndicator(.visible)
            .presentationBackground(DesignTokens.Colors.canvas)
            .presentationBackgroundInteraction(.disabled)
            .presentationContentInteraction(.scrolls)
        }
        .onChange(of: selectedItem?.id) { _, newValue in
            if newValue != nil {
                sheetDetent = ProcessInfo.processInfo.arguments.contains("-expandArticle") ? .large : .medium
            }
        }
        .onChange(of: store.currentStreamBlocks.count) { _, _ in
            openArticleIfRequested()
        }
        .onAppear {
            openArticleIfRequested()
        }
    }

    private func openArticleIfRequested() {
        guard selectedItem == nil else { return }
        let args = ProcessInfo.processInfo.arguments
        let allItems = store.currentStreamBlocks.flatMap(\.items)
        if let idx = args.firstIndex(of: "-openAccession"), idx + 1 < args.count {
            let target = args[idx + 1]
            if let match = allItems.first(where: { $0.accessionNumber == target }) {
                selectedItem = match
            }
            return
        }
        if args.contains("-openFirstArticle"),
           let first = allItems.first(where: { $0.accessionNumber != nil }) {
            selectedItem = first
        }
    }

    private func companyOverviewSection(_ company: HomeCompanyDTO) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(company.name)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                    .lineLimit(1)
                Spacer()
                Text(company.formattedFiscalLabel)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DesignTokens.Colors.textTertiary)
            }

            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("单季营收")
                        .font(.caption2)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(FinanceFormat.compactMoney(company.revenue?.value, currency: company.revenue?.currency ?? "USD"))
                            .font(.headline.weight(.bold).monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textPrimary)
                        if let yoy = company.revenue?.yoyPct {
                            Text(FinanceFormat.signedPercent(yoy))
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(yoy >= 0 ? DesignTokens.Colors.financialUp : DesignTokens.Colors.financialDown)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let om = company.operatingMargin {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("营业利润率")
                            .font(.caption2)
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(String(format: "%.1f%%", om.pct))
                                .font(.headline.weight(.bold).monospacedDigit())
                                .foregroundStyle(DesignTokens.Colors.textPrimary)
                            if let ago = om.yearAgoPct {
                                let diff = om.pct - ago
                                Text("\(diff >= 0 ? "+" : "−")\(String(format: "%.1f", abs(diff))) pts")
                                    .font(.caption2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(diff >= 0 ? DesignTokens.Colors.financialUp : DesignTokens.Colors.financialDown)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if let topFinding = company.topFindings?.first {
                HStack(alignment: .top, spacing: 7) {
                    Circle()
                        .fill(topFinding.kind == "risk" ? DesignTokens.Colors.financialDown : DesignTokens.Colors.techCyan)
                        .frame(width: 5, height: 5)
                        .padding(.top, 5)
                    Text(topFinding.title)
                        .font(.footnote)
                        .fontDesign(.serif)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineLimit(2)
                        .lineSpacing(2)
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }

    private func quarterSectionView(
        quarterHeading: String,
        periodEndLabel: String,
        items: [CompanyStreamItem]
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(quarterHeading)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                Text("截至 \(periodEndLabel)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
            }
            .padding(.top, 10)
            .padding(.bottom, 2)

            VStack(spacing: 0) {
                ForEach(items) { item in
                    streamItemRow(item)

                    if item.id != items.last?.id {
                        Divider()
                            .overlay(DesignTokens.Colors.hairline)
                            .padding(.leading, 28)
                    }
                }
            }
        }
    }

    private func streamItemRow(_ item: CompanyStreamItem) -> some View {
        Button {
            selectedItem = item
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: item.iconName)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(
                        item.isNegativeSignal
                            ? DesignTokens.Colors.textSecondary
                            : DesignTokens.Colors.textPrimary
                    )
                    .frame(width: 18, alignment: .center)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)

                    Text(item.metaLine)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func toggleCategory(_ category: StreamFilterCategory) {
        DesignTokens.selectionTick()
        if enabledCategories.contains(category) {
            if enabledCategories.count > 1 {
                enabledCategories.remove(category)
            }
        } else {
            enabledCategories.insert(category)
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

struct CompanyStreamDetailSheet: View {
    @Environment(SpontraStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let ticker: String
    let item: CompanyStreamItem
    let isExpanded: Bool

    @State private var detail: FilingDetailAPIResponse?
    @State private var isLoadingArticle = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            DesignTokens.Colors.canvas.ignoresSafeArea()

            if isLoadingArticle {
                VStack(spacing: 10) {
                    ProgressView().tint(DesignTokens.Colors.techCyan)
                    Text("正在加载线上文章...")
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let html = detail?.artifact?.html, !html.isEmpty {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(item.metaLine)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textSecondary)

                        ArtifactBlocksView(html: html)

                        if let raw = item.edgarUrl, let url = URL(string: raw) {
                            Divider().overlay(DesignTokens.Colors.hairline)
                                .padding(.top, 6)
                            Link(destination: url) {
                                HStack {
                                    Image(systemName: "safari")
                                    Text("在 SEC EDGAR 查看原始申报")
                                        .font(.footnote.weight(.semibold))
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption2.weight(.bold))
                                }
                                .foregroundStyle(DesignTokens.Colors.techCyan)
                                .padding(.vertical, 6)
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, isExpanded ? 64 : 22)
                    .padding(.bottom, 36)
                }
            } else {
                fallbackScrollContent
            }

            // 全屏详情使用返回按钮，半屏详情使用系统拖动条。
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
        .task(id: item.id) {
            guard let accession = item.accessionNumber else { return }
            isLoadingArticle = true
            detail = await store.loadFilingDetail(ticker: ticker, accession: accession)
            isLoadingArticle = false
        }
    }

    private var fallbackScrollContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(item.metaLine)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DesignTokens.Colors.textSecondary)

                Text(item.title)
                    .font(.headline.weight(.bold))
                    .fontDesign(.serif)
                    .foregroundStyle(DesignTokens.Colors.textPrimary)

                Divider().overlay(DesignTokens.Colors.hairline)

                if let reportMarkdown = detail?.filing?.summary?.report, !reportMarkdown.isEmpty {
                    Text(reportMarkdown)
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineSpacing(4)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("披露摘要")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                        Text(item.detailBody)
                            .font(.footnote)
                            .foregroundStyle(DesignTokens.Colors.textPrimary)
                            .lineSpacing(4)
                        Text(item.sourceLabel)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textTertiary)
                    }
                }

                if let raw = item.edgarUrl, let url = URL(string: raw) {
                    Link(destination: url) {
                        HStack {
                            Image(systemName: "safari")
                            Text("在 SEC EDGAR 查看原始文件")
                                .font(.footnote.weight(.semibold))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(height: 42)
                        .background(DesignTokens.Colors.techBlue, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .padding(.top, 4)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, isExpanded ? 64 : 22)
            .padding(.bottom, 32)
        }
        .background(DesignTokens.Colors.canvas.ignoresSafeArea())
    }
}

// MARK: - 线上 HTML 文章原生 SwiftUI 渲染器（零白屏/黑屏延迟，支持深浅模式、动态字体与表格）

private enum ArtifactBlock: Identifiable {
    case heading(id: Int, level: Int, text: String)
    case paragraph(id: Int, text: String)
    case qaTerm(id: Int, text: String)
    case qaDetail(id: Int, text: String)
    case bullet(id: Int, text: String)
    case table(id: Int, rows: [[String]])
    case divider(id: Int)

    var id: Int {
        switch self {
        case .heading(let id, _, _),
             .paragraph(let id, _),
             .qaTerm(let id, _),
             .qaDetail(let id, _),
             .bullet(let id, _),
             .table(let id, _),
             .divider(let id):
            return id
        }
    }
}

struct ArtifactBlocksView: View {
    let html: String

    private var blocks: [ArtifactBlock] {
        Self.parse(html: html)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block {
                case .heading(_, let level, let text):
                    Text(text)
                        .font(level <= 2 ? .headline.weight(.bold) : .subheadline.weight(.semibold))
                        .fontDesign(level <= 2 ? .serif : .default)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .padding(.top, level <= 2 ? 6 : 4)
                        .fixedSize(horizontal: false, vertical: true)

                case .paragraph(_, let text):
                    Text(text)
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineSpacing(4.5)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                case .qaTerm(_, let text):
                    Text(text)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .padding(.top, 6)

                case .qaDetail(_, let text):
                    Text(text)
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)

                case .bullet(_, let text):
                    HStack(alignment: .top, spacing: 7) {
                        Text("•")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(DesignTokens.Colors.techCyan)
                        Text(text)
                            .font(.footnote)
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                            .lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                case .table(_, let rows):
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, cols in
                                HStack(spacing: 14) {
                                    ForEach(Array(cols.enumerated()), id: \.offset) { colIdx, cell in
                                        Text(cell)
                                            .font(rowIdx == 0 ? .caption2.weight(.semibold) : .caption2.monospacedDigit())
                                            .foregroundStyle(
                                                rowIdx == 0
                                                    ? DesignTokens.Colors.textSecondary
                                                    : DesignTokens.Colors.textPrimary
                                            )
                                            .frame(minWidth: colIdx == 0 ? 110 : 72, alignment: colIdx == 0 ? .leading : .trailing)
                                    }
                                }
                                .padding(.vertical, 7)
                                if rowIdx < rows.count - 1 {
                                    Divider().overlay(DesignTokens.Colors.hairline)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)

                case .divider:
                    Divider()
                        .overlay(DesignTokens.Colors.hairline)
                        .padding(.vertical, 6)
                }
            }
        }
    }

    // MARK: 轻量 HTML 结构化解析器（匹配 Spontra artifact-html 允许标签）

    private static func parse(html: String) -> [ArtifactBlock] {
        var result: [ArtifactBlock] = []
        var nextId = 0

        // 去掉 script / style / svg
        let cleaned = html
            .replacingOccurrences(of: #"(?is)<(script|style|svg)\b[^>]*>.*?</\1>"#, with: "", options: .regularExpression)

        // 按 block 级标签顺序提取
        let pattern = #"(?is)<(h1|h2|h3|p|dt|dd|li|table)\b[^>]*>(.*?)</\1>|(</section>)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = cleaned as NSString
        let matches = regex.matches(in: cleaned, range: NSRange(location: 0, length: ns.length))

        for m in matches {
            if m.range(at: 3).location != NSNotFound {
                if !result.isEmpty {
                    result.append(.divider(id: nextId))
                    nextId += 1
                }
                continue
            }
            let tag = ns.substring(with: m.range(at: 1)).lowercased()
            let inner = ns.substring(with: m.range(at: 2))

            if tag == "table" {
                let rows = parseTableRows(inner)
                if !rows.isEmpty {
                    result.append(.table(id: nextId, rows: rows))
                    nextId += 1
                }
                continue
            }

            let text = stripHTML(inner)
            guard !text.isEmpty else { continue }

            switch tag {
            case "h1", "h2":
                result.append(.heading(id: nextId, level: 2, text: text))
            case "h3":
                result.append(.heading(id: nextId, level: 3, text: text))
            case "p":
                result.append(.paragraph(id: nextId, text: text))
            case "dt":
                result.append(.qaTerm(id: nextId, text: text))
            case "dd":
                result.append(.qaDetail(id: nextId, text: text))
            case "li":
                result.append(.bullet(id: nextId, text: text))
            default:
                continue
            }
            nextId += 1
        }

        // 去掉末尾多余分隔线
        if case .divider = result.last {
            result.removeLast()
        }
        return result
    }

    private static func parseTableRows(_ tableHTML: String) -> [[String]] {
        guard let rowRegex = try? NSRegularExpression(pattern: #"(?is)<tr\b[^>]*>(.*?)</tr>"#),
              let cellRegex = try? NSRegularExpression(pattern: #"(?is)<(th|td)\b[^>]*>(.*?)</\1>"#) else {
            return []
        }
        let ns = tableHTML as NSString
        var rows: [[String]] = []
        for rm in rowRegex.matches(in: tableHTML, range: NSRange(location: 0, length: ns.length)) {
            let rowStr = ns.substring(with: rm.range(at: 1))
            let rowNS = rowStr as NSString
            let cells = cellRegex.matches(in: rowStr, range: NSRange(location: 0, length: rowNS.length))
                .map { stripHTML(rowNS.substring(with: $0.range(at: 2))) }
            if !cells.isEmpty { rows.append(cells) }
        }
        return rows
    }

    private static func stripHTML(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: #"(?is)<[^>]+>"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
