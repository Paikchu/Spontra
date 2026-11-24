import Foundation
import Observation
import SwiftUI

enum WorkspaceDestination: String, CaseIterable, Identifiable {
    case macro      // 侧边栏固定项：宏观
    case industry   // 侧边栏固定项：行业
    case company    // 侧边栏自选公司
    var id: String { rawValue }
}

enum CompanyStatement: String, CaseIterable {
    case profit, cash, balance

    var label: String {
        switch self {
        case .profit: "利润"
        case .cash: "现金流"
        case .balance: "资产负债表"
        }
    }
}

enum CompanySubView: CaseIterable, Identifiable, Hashable {
    case stream     // 公司动态（财报 + 管理层动态）
    case statement(CompanyStatement)
    case valuation  // 公司估值

    static var allCases: [Self] { [.stream] + CompanyStatement.allCases.map(Self.statement) + [.valuation] }
    var id: Self { self }

    var label: String {
        switch self {
        case .stream: "动态"
        case .statement(let statement): statement.label
        case .valuation: "估值"
        }
    }
}

enum ColorSchemePreference: String, CaseIterable {
    case dark, light

    var colorScheme: ColorScheme {
        self == .dark ? .dark : .light
    }

    var toggleIcon: String {
        self == .dark ? "sun.max" : "moon.stars"
    }
}

@Observable
@MainActor
final class SpontraStore {
    // MARK: 导航与菜单浮层状态
    var activeDestination: WorkspaceDestination = .company
    var companySubView: CompanySubView = .stream
    var isMenuOpen: Bool = false
    var isSearchSheetPresented: Bool = false
    var colorSchemePreference: ColorSchemePreference = .dark

    // MARK: 公司目录 & 本地自选（UserDefaults）
    var companies: [HomeCompanyDTO] = []
    var selectedTicker: String = "CRWV"
    var watchlistTickers: [String] = []

    // MARK: 宏观 / 行业研报
    var researchReports: [PublicReportSummaryDTO] = []
    var researchDetails: [String: PublicReportDetailDTO] = [:]

    // MARK: 当前公司的估值与动态流缓存
    var valuationsByTicker: [String: ValuationAPIResponse] = [:]
    var streamBlocksByTicker: [String: [CompanyStreamBlock]] = [:]
    var filingDetailsByKey: [String: FilingDetailAPIResponse] = [:]

    // MARK: 加载与错误状态
    var isBootstrapping: Bool = false
    var isLoadingCompanyData: Bool = false
    var isLoadingResearch: Bool = false
    var globalError: String?
    var companyError: String?

    private let watchlistKey = "spontra.ios.watchlist.v1"
    private let themeKey = "spontra.ios.theme.v1"
    private let api = SpontraAPIClient.shared

    init() {
        loadLocalPreferences()
        applyLaunchArgumentsIfPresent()
    }

    var selectedCompany: HomeCompanyDTO? {
        companies.first(where: { $0.ticker == selectedTicker })
    }

    var watchlistCompanies: [HomeCompanyDTO] {
        let map = Dictionary(uniqueKeysWithValues: companies.map { ($0.ticker, $0) })
        return watchlistTickers.compactMap { map[$0] }
    }

    var otherCoveredCompanies: [HomeCompanyDTO] {
        let watched = Set(watchlistTickers)
        return companies.filter { !watched.contains($0.ticker) }
    }

    var currentValuation: ValuationAPIResponse? {
        valuationsByTicker[selectedTicker]
    }

    var currentStreamBlocks: [CompanyStreamBlock] {
        streamBlocksByTicker[selectedTicker] ?? []
    }

    func isWatched(_ ticker: String) -> Bool {
        watchlistTickers.contains(ticker)
    }

    // MARK: 本地自选读写

    private func loadLocalPreferences() {
        if let saved = UserDefaults.standard.stringArray(forKey: watchlistKey), !saved.isEmpty {
            watchlistTickers = saved
        } else {
            watchlistTickers = ["CRWV", "NVDA", "MSFT", "GOOGL"]
            UserDefaults.standard.set(watchlistTickers, forKey: watchlistKey)
        }
        if let rawTheme = UserDefaults.standard.string(forKey: themeKey),
           let pref = ColorSchemePreference(rawValue: rawTheme) {
            colorSchemePreference = pref
        }
    }

    private func applyLaunchArgumentsIfPresent() {
        let args = ProcessInfo.processInfo.arguments
        if let idx = args.firstIndex(of: "-tab"), idx + 1 < args.count {
            switch args[idx + 1] {
            case "macro", "research":
                activeDestination = .macro
            case "industry":
                activeDestination = .industry
            case "valuation":
                activeDestination = .company
                companySubView = .valuation
            case "company":
                activeDestination = .company
                companySubView = .stream
            default:
                break
            }
        }
        if let idx = args.firstIndex(of: "-ticker"), idx + 1 < args.count {
            selectedTicker = args[idx + 1].uppercased()
        }
        if let idx = args.firstIndex(of: "-theme"), idx + 1 < args.count,
           let pref = ColorSchemePreference(rawValue: args[idx + 1]) {
            colorSchemePreference = pref
        }
        if args.contains("-openMenu") {
            isMenuOpen = true
        }
    }

    func toggleWatchlist(_ ticker: String) {
        if let idx = watchlistTickers.firstIndex(of: ticker) {
            watchlistTickers.remove(at: idx)
        } else {
            watchlistTickers.insert(ticker, at: 0)
        }
        UserDefaults.standard.set(watchlistTickers, forKey: watchlistKey)
        DesignTokens.lightImpact()
    }

    func toggleColorScheme() {
        colorSchemePreference = (colorSchemePreference == .dark) ? .light : .dark
        UserDefaults.standard.set(colorSchemePreference.rawValue, forKey: themeKey)
        DesignTokens.lightImpact()
    }

    func selectDestination(_ destination: WorkspaceDestination) {
        activeDestination = destination
        withAnimation(DesignTokens.Motion.transitionSpring) {
            isMenuOpen = false
        }
    }

    func selectCompany(_ ticker: String) {
        selectedTicker = ticker
        activeDestination = .company
        withAnimation(DesignTokens.Motion.transitionSpring) {
            isMenuOpen = false
        }
        Task {
            await loadCompanyBundle(ticker: ticker, force: false)
        }
    }

    // MARK: 后台 API 加载

    func bootstrap() async {
        guard !isBootstrapping else { return }
        isBootstrapping = true
        globalError = nil
        defer { isBootstrapping = false }

        async let homeTask = api.fetchHomeDigest()
        async let researchTask = api.fetchResearchList()

        do {
            let home = try await homeTask
            companies = home.companies.sorted { lhs, rhs in
                let lWatched = watchlistTickers.contains(lhs.ticker)
                let rWatched = watchlistTickers.contains(rhs.ticker)
                if lWatched != rWatched { return lWatched }
                return lhs.ticker < rhs.ticker
            }
            if !companies.contains(where: { $0.ticker == selectedTicker }),
               let fallback = companies.first?.ticker {
                selectedTicker = fallback
            }
        } catch {
            globalError = "加载公司列表失败：\(error.localizedDescription)"
        }

        do {
            let research = try await researchTask
            researchReports = research.reports
        } catch {
            // 宏观/行业失败不阻断公司研究主链路
        }

        await loadCompanyBundle(ticker: selectedTicker, force: false)
    }

    func refreshAll() async {
        isLoadingResearch = true
        defer { isLoadingResearch = false }

        async let homeTask = try? api.fetchHomeDigest()
        async let researchTask = try? api.fetchResearchList()
        async let companyTask: Void = loadCompanyBundle(ticker: selectedTicker, force: true)

        let (home, res, _) = await (homeTask, researchTask, companyTask)
        if let home {
            companies = home.companies
        }
        if let res {
            researchReports = res.reports
        }
    }

    func loadCompanyBundle(ticker: String, force: Bool) async {
        if !force,
           valuationsByTicker[ticker] != nil,
           streamBlocksByTicker[ticker] != nil {
            return
        }

        isLoadingCompanyData = true
        companyError = nil
        defer { isLoadingCompanyData = false }

        async let valResult: ValuationAPIResponse? = try? api.fetchValuation(ticker: ticker)
        async let filingsResult: FilingDigestsResponse? = try? api.fetchFilings(ticker: ticker)
        async let eventsResult: EventsAPIResponse? = try? api.fetchEvents(ticker: ticker)

        let (val, filingsResp, eventsResp) = await (valResult, filingsResult, eventsResult)

        if let val {
            valuationsByTicker[ticker] = val
        }

        let filings = filingsResp?.filings?.filings ?? []
        let events = eventsResp?.events?.events ?? []
        let assembled = Self.buildStreamBlocks(filings: filings, events: events)
        if !assembled.isEmpty {
            streamBlocksByTicker[ticker] = assembled
        } else if val == nil {
            companyError = "无法读取 \(ticker) 的最新公开数据，请下拉重试。"
        }
    }

    func loadResearchDetail(for summary: PublicReportSummaryDTO) async -> PublicReportDetailDTO? {
        if let cached = researchDetails[summary.id] {
            return cached
        }
        if let resp = try? await api.fetchResearchDetail(reportId: summary.reportId, version: summary.version),
           let detail = resp.report {
            researchDetails[summary.id] = detail
            return detail
        }
        return nil
    }

    func loadFilingDetail(ticker: String, accession: String) async -> FilingDetailAPIResponse? {
        let key = "\(ticker):\(accession)"
        if let cached = filingDetailsByKey[key] {
            return cached
        }
        if let detail = try? await api.fetchFilingDetail(ticker: ticker, accession: accession) {
            filingDetailsByKey[key] = detail
            return detail
        }
        return nil
    }

    // MARK: 将 /filings 与 /events 合并为网页同款时间线（仅财报与业绩 8-K 归入财季框，其余按时间倒序独立排列）

    private struct RawStreamEntry {
        let item: CompanyStreamItem
        let isPeriodicReport: Bool
        let periodEnd: String?
        let explicitQuarterHeading: String?
    }

    private static func buildStreamBlocks(
        filings: [PublicFilingDigestDTO],
        events: [CompanyEventDTO]
    ) -> [CompanyStreamBlock] {
        let periodicFilings = filings.filter { $0.periodEnd != nil && !($0.periodEnd?.isEmpty ?? true) }
        var nonPeriodicByAcc: [String: PublicFilingDigestDTO] = [:]
        for f in filings where f.periodEnd == nil || f.periodEnd?.isEmpty == true {
            nonPeriodicByAcc[f.accessionNumber] = f
        }

        let reportPeriodEnds = periodicFilings.compactMap(\.periodEnd)
        let anchorPeriodEnd = reportPeriodEnds.max()

        // 预先收集所有业绩公告的披露日，用于 releasedPeriod 去重判断（对齐 Web event-noise.ts）
        let earningsReleaseDates: [(id: String, date: String)] = events.compactMap { e in
            guard isEarningsRelease(e) else { return nil }
            return (e.id, e.filedAt)
        }

        var entries: [RawStreamEntry] = []
        var seenAccessions = Set<String>()

        // 1. 定期财报（10-Q / 10-K / 20-F / 40-F）
        for f in periodicFilings.prefix(40) {
            seenAccessions.insert(f.accessionNumber)
            let periodEnd = f.periodEnd!
            let headline = trimmedNonEmpty(f.headline) ?? "\(f.form) 申报文件"
            let dateStr = f.date ?? f.filingDate
            let md = FinanceFormat.shortMonthDay(dateStr)
            let quarter = trimmedNonEmpty(f.periodLabel) ?? inferQuarterHeading(from: periodEnd)
            let periodEndLabel = FinanceFormat.dotDate(periodEnd)
            let metaParts = [md, "财报", f.periodLabel, f.form].compactMap { $0 }.filter { !$0.isEmpty }

            let item = CompanyStreamItem(
                id: "filing-\(f.accessionNumber)",
                accessionNumber: f.accessionNumber,
                category: .reports,
                iconName: "doc.text",
                isNegativeSignal: false,
                title: headline,
                metaLine: metaParts.joined(separator: " · "),
                sortDate: dateStr,
                quarterHeading: quarter,
                periodEndLabel: periodEndLabel,
                detailBody: buildFilingDetailBody(f),
                sourceLabel: "SEC \(f.form) · 披露日 \(dateStr)",
                edgarUrl: f.edgarUrl
            )
            entries.append(RawStreamEntry(
                item: item,
                isPeriodicReport: true,
                periodEnd: periodEnd,
                explicitQuarterHeading: quarter
            ))
        }

        // 2. 事件（8-K 业绩公告 / 重大公告 / Form 4 内部人交易）
        for e in events.prefix(120) {
            if let insider = e.insider {
                let soldShares = insider.sold?.shares ?? 0
                let boughtShares = insider.bought?.shares ?? 0
                // 过滤掉无买卖方向的纯授股/行权噪音，聚焦真实卖出或买入
                guard soldShares > 0 || boughtShares > 0 else { continue }

                let isSell = soldShares >= boughtShares
                let actionWord = isSell ? "卖出" : "买入"
                let md = FinanceFormat.shortMonthDay(e.filedAt)
                let roleText = insider.title ?? (insider.isDirector == true ? "董事" : "内部人")
                let metaLine = "\(md) · 内部人交易 · \(roleText) · Form \(e.form)"
                let quarter = inferQuarterHeading(from: e.eventDate ?? e.filedAt)
                let periodEnd = inferQuarterEnd(from: e.eventDate ?? e.filedAt)

                var detailParts: [String] = ["申报人：\(insider.ownerName)（\(roleText)）"]
                if isSell {
                    var line = "公开市场卖出：\(Int(soldShares).formatted()) 股"
                    if let avg = insider.sold?.averagePrice {
                        line += "，均价 \(FinanceFormat.price(avg))"
                    }
                    if let proceeds = insider.sold?.proceeds {
                        line += "，金额约 \(FinanceFormat.compactMoney(proceeds))"
                    }
                    detailParts.append(line)
                } else {
                    var line = "公开市场买入：\(Int(boughtShares).formatted()) 股"
                    if let avg = insider.bought?.averagePrice {
                        line += "，均价 \(FinanceFormat.price(avg))"
                    }
                    if let cost = insider.bought?.cost {
                        line += "，金额约 \(FinanceFormat.compactMoney(cost))"
                    }
                    detailParts.append(line)
                }
                if insider.rule10b51 == true {
                    detailParts.append("交易计划：依据 Rule 10b5-1 预设交易计划执行。")
                }

                let item = CompanyStreamItem(
                    id: "event-\(e.id)",
                    accessionNumber: nil,
                    category: .management,
                    iconName: isSell ? "arrow.down.right.circle" : "arrow.up.right.circle",
                    isNegativeSignal: isSell,
                    title: "\(insider.ownerName) \(actionWord)",
                    metaLine: metaLine,
                    sortDate: e.filedAt,
                    quarterHeading: quarter,
                    periodEndLabel: periodEnd,
                    detailBody: detailParts.joined(separator: "\n\n"),
                    sourceLabel: "SEC Form \(e.form) · 披露日 \(e.filedAt)",
                    edgarUrl: e.edgarUrl
                )
                entries.append(RawStreamEntry(
                    item: item,
                    isPeriodicReport: false,
                    periodEnd: nil,
                    explicitQuarterHeading: nil
                ))
            } else if !seenAccessions.contains(e.id) {
                let matchingFiling = nonPeriodicByAcc[e.id]
                let earnings = isEarningsRelease(e)
                let headline = trimmedNonEmpty(e.summary?.headline)
                    ?? trimmedNonEmpty(matchingFiling?.headline)
                    ?? (earnings ? "\(e.form) 业绩公告" : nil)
                guard let headline else { continue }

                seenAccessions.insert(e.id)
                let md = FinanceFormat.shortMonthDay(e.filedAt)
                // 对齐 Web event-noise.ts：仅 executive 与 insider 归入管理层动态，其余归入财报/公告
                let isMgmt = e.eventClass == "executive"
                let classWord = eventClassLabel(e.eventClass)
                let matchedPeriod = earnings
                    ? releasedPeriod(
                        filed: e.filedAt,
                        eventId: e.id,
                        reportPeriodEnds: reportPeriodEnds,
                        anchor: anchorPeriodEnd,
                        earningsReleaseDates: earningsReleaseDates
                    )
                    : nil
                let quarter = matchedPeriod.map(inferQuarterHeading(from:))
                    ?? inferQuarterHeading(from: e.eventDate ?? e.filedAt)
                let periodEndLabel = matchedPeriod.map(FinanceFormat.dotDate)
                    ?? FinanceFormat.dotDate(e.eventDate ?? e.filedAt)

                let detailBody: String
                if let view = trimmedNonEmpty(e.summary?.analystView) {
                    detailBody = view
                } else if let matchingFiling {
                    detailBody = buildFilingDetailBody(matchingFiling)
                } else {
                    detailBody = headline
                }

                let item = CompanyStreamItem(
                    id: "event-\(e.id)",
                    accessionNumber: e.id,
                    category: isMgmt ? .management : .reports,
                    iconName: isMgmt ? "person.badge.clock" : "doc.text",
                    isNegativeSignal: false,
                    title: headline,
                    metaLine: "\(md) · \(classWord) · \(e.form)",
                    sortDate: e.filedAt,
                    quarterHeading: quarter,
                    periodEndLabel: periodEndLabel,
                    detailBody: detailBody,
                    sourceLabel: "SEC \(e.form) · 披露日 \(e.filedAt)",
                    edgarUrl: e.edgarUrl ?? matchingFiling?.edgarUrl
                )
                entries.append(RawStreamEntry(
                    item: item,
                    isPeriodicReport: false,
                    periodEnd: matchedPeriod,
                    explicitQuarterHeading: nil
                ))
            }
        }

        // 3. 兜底：若 /filings 中有带标题的非定期报告未出现在 /events 中，也纳入时间线
        for f in filings where !seenAccessions.contains(f.accessionNumber) {
            guard let headline = trimmedNonEmpty(f.headline) else { continue }
            seenAccessions.insert(f.accessionNumber)
            let dateStr = f.date ?? f.filingDate
            let md = FinanceFormat.shortMonthDay(dateStr)
            let item = CompanyStreamItem(
                id: "filing-\(f.accessionNumber)",
                accessionNumber: f.accessionNumber,
                category: .reports,
                iconName: "doc.text",
                isNegativeSignal: false,
                title: headline,
                metaLine: "\(md) · 公告 · \(f.form)",
                sortDate: dateStr,
                quarterHeading: inferQuarterHeading(from: dateStr),
                periodEndLabel: FinanceFormat.dotDate(dateStr),
                detailBody: buildFilingDetailBody(f),
                sourceLabel: "SEC \(f.form) · 披露日 \(dateStr)",
                edgarUrl: f.edgarUrl
            )
            entries.append(RawStreamEntry(
                item: item,
                isPeriodicReport: false,
                periodEnd: nil,
                explicitQuarterHeading: nil
            ))
        }

        // 4. 按披露日期倒序排列（同日定期财报优先），对齐 Web streamBlocks()：
        //    仅同一财季的定期财报与业绩 8-K 合并进财季框，其余条目保持在各自披露日期位置
        let sorted = entries.sorted { lhs, rhs in
            if lhs.item.sortDate != rhs.item.sortDate {
                return lhs.item.sortDate > rhs.item.sortDate
            }
            if lhs.isPeriodicReport != rhs.isPeriodicReport {
                return lhs.isPeriodicReport
            }
            return lhs.item.id < rhs.item.id
        }

        var blocks: [CompanyStreamBlock] = []
        var quarterIndices: [(periodEnd: String, blockIndex: Int)] = []

        for entry in sorted {
            guard let periodEnd = entry.periodEnd else {
                blocks.append(.standalone(entry.item))
                continue
            }

            if let match = quarterIndices.first(where: { sameQuarter($0.periodEnd, periodEnd) }),
               case .quarter(let id, let existingHeading, let existingPeriodLabel, var existingItems) = blocks[match.blockIndex] {
                existingItems.append(entry.item)
                let resolvedHeading = entry.explicitQuarterHeading ?? existingHeading
                blocks[match.blockIndex] = .quarter(
                    id: id,
                    quarterHeading: resolvedHeading,
                    periodEndLabel: existingPeriodLabel,
                    items: existingItems
                )
            } else {
                let heading = entry.explicitQuarterHeading ?? inferQuarterHeading(from: periodEnd)
                let periodLabel = FinanceFormat.dotDate(periodEnd)
                let blockIndex = blocks.count
                blocks.append(.quarter(
                    id: "quarter-\(periodEnd)",
                    quarterHeading: heading,
                    periodEndLabel: periodLabel,
                    items: [entry.item]
                ))
                quarterIndices.append((periodEnd, blockIndex))
            }
        }

        return blocks
    }

    private static func trimmedNonEmpty(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func buildFilingDetailBody(_ f: PublicFilingDigestDTO) -> String {
        var detailLines: [String] = []
        if let view = trimmedNonEmpty(f.analystView) { detailLines.append(view) }
        if let risks = f.risks, !risks.isEmpty {
            detailLines.append("主要风险：\n" + risks.map { "• \($0)" }.joined(separator: "\n"))
        }
        if let guidance = f.guidance, !guidance.isEmpty {
            detailLines.append("指引要点：\n" + guidance.map { "• \($0)" }.joined(separator: "\n"))
        }
        if detailLines.isEmpty {
            detailLines.append("该份 SEC \(f.form) 文件已收录，完整原始文本可通过 EDGAR 链接核验。")
        }
        return detailLines.joined(separator: "\n\n")
    }

    private static func isEarningsRelease(_ e: CompanyEventDTO) -> Bool {
        guard e.eventClass == "earnings" else { return false }
        return (e.items ?? []).contains("2.02") || !e.form.hasPrefix("8-K")
    }

    /// 对齐 Web event-noise.ts 的 releasedPeriod()：业绩 8-K 归属到披露日之前最近结束的财季
    private static func releasedPeriod(
        filed: String,
        eventId: String,
        reportPeriodEnds: [String],
        anchor: String?,
        earningsReleaseDates: [(id: String, date: String)]
    ) -> String? {
        var ends = reportPeriodEnds.filter { $0 < filed }
        if let anchor {
            var step = 0
            while let candidate = addMonths(anchor, months: 3 * step), candidate >= filed, step > -400 {
                step -= 1
            }
            while let candidate = addMonths(anchor, months: 3 * (step + 1)), candidate < filed, step < 400 {
                step += 1
            }
            if let candidate = addMonths(anchor, months: 3 * step), candidate < filed {
                ends.append(candidate)
            }
        }
        guard let quarter = ends.max() else { return nil }
        let hasEarlierRelease = earningsReleaseDates.contains { other in
            other.id != eventId && other.date > quarter && other.date < filed
        }
        return hasEarlierRelease ? nil : quarter
    }

    private static func sameQuarter(_ a: String, _ b: String) -> Bool {
        guard let dateA = parseISODate(a), let dateB = parseISODate(b) else {
            return a == b
        }
        return abs(dateA.timeIntervalSince(dateB)) <= 10 * 86_400
    }

    private static func addMonths(_ iso: String, months: Int) -> String? {
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        guard let base = cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
              let rangeBase = cal.range(of: .day, in: .month, for: base),
              let shiftedFirst = cal.date(byAdding: .month, value: months, to: cal.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))!),
              let rangeTarget = cal.range(of: .day, in: .month, for: shiftedFirst) else {
            return nil
        }
        let targetComps = cal.dateComponents([.year, .month], from: shiftedFirst)
        let isLastDay = parts[2] == rangeBase.count
        let targetDay = isLastDay ? rangeTarget.count : min(parts[2], rangeTarget.count)
        guard let y = targetComps.year, let m = targetComps.month else { return nil }
        return String(format: "%04d-%02d-%02d", y, m, targetDay)
    }

    private static func parseISODate(_ iso: String) -> Date? {
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    private static func eventClassLabel(_ raw: String?) -> String {
        switch raw {
        case "earnings": "业绩"
        case "guidance": "指引"
        case "executive": "高管变动"
        case "financing": "融资"
        case "deal": "交易合作"
        case "capital_return": "资本回报"
        case "legal": "法律事项"
        default: "公告"
        }
    }

    private static func inferQuarterHeading(from iso: String) -> String {
        guard iso.count >= 7,
              let year = Int(iso.prefix(4)),
              let month = Int(iso.dropFirst(5).prefix(2)) else {
            return "近期动态"
        }
        let q = ((month - 1) / 3) + 1
        return "\(year) 财年 Q\(q)"
    }

    private static func inferQuarterEnd(from iso: String) -> String {
        guard iso.count >= 7,
              let year = Int(iso.prefix(4)),
              let month = Int(iso.dropFirst(5).prefix(2)) else {
            return FinanceFormat.dotDate(iso)
        }
        switch ((month - 1) / 3) + 1 {
        case 1: return "\(year).03.31"
        case 2: return "\(year).06.30"
        case 3: return "\(year).09.30"
        default: return "\(year).12.31"
        }
    }
}
