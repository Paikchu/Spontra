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
    var streamSectionsByTicker: [String: [CompanyStreamQuarterSection]] = [:]
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
        companies.first(where: { $0.ticker == selectedTicker }) ?? companies.first
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

    var currentStreamSections: [CompanyStreamQuarterSection] {
        streamSectionsByTicker[selectedTicker] ?? []
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
           streamSectionsByTicker[ticker] != nil {
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
        let assembled = Self.buildStreamSections(filings: filings, events: events)
        if !assembled.isEmpty {
            streamSectionsByTicker[ticker] = assembled
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

    // MARK: 将 /filings 与 /events 合并为网页同款按财季分组的时间线

    private static func buildStreamSections(
        filings: [PublicFilingDigestDTO],
        events: [CompanyEventDTO]
    ) -> [CompanyStreamQuarterSection] {
        var items: [CompanyStreamItem] = []
        var seenAccessions = Set<String>()

        // 1. 财报与 8-K 摘要
        for f in filings.prefix(40) {
            seenAccessions.insert(f.accessionNumber)
            let headline = (f.headline?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? "\(f.form) 申报文件"
            let dateStr = f.date ?? f.filingDate
            let md = FinanceFormat.shortMonthDay(dateStr)
            let quarter = f.periodLabel ?? inferQuarterHeading(from: f.periodEnd ?? f.reportDate ?? dateStr)
            let periodEnd = FinanceFormat.dotDate(f.periodEnd ?? f.reportDate ?? dateStr)

            let kindTag = (f.form.contains("10-") || f.form.contains("20-F")) ? "财报" : "业绩"
            let metaParts = [md, kindTag, f.periodLabel, f.form].compactMap { $0 }.filter { !$0.isEmpty }

            var detailLines: [String] = []
            if let view = f.analystView, !view.isEmpty { detailLines.append(view) }
            if let risks = f.risks, !risks.isEmpty {
                detailLines.append("主要风险：\n" + risks.map { "• \($0)" }.joined(separator: "\n"))
            }
            if let guidance = f.guidance, !guidance.isEmpty {
                detailLines.append("指引要点：\n" + guidance.map { "• \($0)" }.joined(separator: "\n"))
            }
            if detailLines.isEmpty {
                detailLines.append("该份 SEC \(f.form) 文件已收录，完整原始文本可通过 EDGAR 链接核验。")
            }

            items.append(CompanyStreamItem(
                id: "filing-\(f.accessionNumber)",
                accessionNumber: f.accessionNumber,
                category: .reports,
                iconName: "doc.text",
                isNegativeSignal: false,
                title: headline,
                metaLine: metaParts.joined(separator: " · "),
                sortDate: dateStr,
                quarterHeading: quarter,
                periodEndLabel: periodEnd,
                detailBody: detailLines.joined(separator: "\n\n"),
                sourceLabel: "SEC \(f.form) · 披露日 \(dateStr)",
                edgarUrl: f.edgarUrl
            ))
        }

        // 2. 管理层动态（Form 4 内部人交易）与未在 filings 中出现的重大事件
        for e in events.prefix(60) {
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

                items.append(CompanyStreamItem(
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
                ))
            } else if !seenAccessions.contains(e.id), let headline = e.summary?.headline, !headline.isEmpty {
                let md = FinanceFormat.shortMonthDay(e.filedAt)
                let isMgmt = e.eventClass == "executive" || e.eventClass == "vote"
                let classWord = eventClassLabel(e.eventClass)
                let quarter = inferQuarterHeading(from: e.eventDate ?? e.filedAt)
                let periodEnd = inferQuarterEnd(from: e.eventDate ?? e.filedAt)

                items.append(CompanyStreamItem(
                    id: "event-\(e.id)",
                    accessionNumber: e.id,
                    category: isMgmt ? .management : .reports,
                    iconName: isMgmt ? "person.badge.clock" : "doc.text",
                    isNegativeSignal: false,
                    title: headline,
                    metaLine: "\(md) · \(classWord) · \(e.form)",
                    sortDate: e.filedAt,
                    quarterHeading: quarter,
                    periodEndLabel: periodEnd,
                    detailBody: (e.summary?.analystView?.isEmpty == false ? e.summary!.analystView! : headline),
                    sourceLabel: "SEC \(e.form) · 披露日 \(e.filedAt)",
                    edgarUrl: e.edgarUrl
                ))
            }
        }

        // 按日期倒序，再按财季分组（保持最新财季在前）
        let sorted = items.sorted { $0.sortDate > $1.sortDate }
        var groupOrder: [String] = []
        var grouped: [String: (periodEnd: String, items: [CompanyStreamItem])] = [:]

        for item in sorted {
            let key = item.quarterHeading
            if grouped[key] == nil {
                groupOrder.append(key)
                grouped[key] = (item.periodEndLabel, [])
            }
            grouped[key]?.items.append(item)
        }

        return groupOrder.compactMap { key in
            guard let entry = grouped[key] else { return nil }
            return CompanyStreamQuarterSection(
                quarterHeading: key,
                periodEndLabel: entry.periodEnd,
                items: entry.items
            )
        }
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
