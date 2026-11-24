import Foundation

// MARK: - 1. /api/business/v1/home?lang=zh-CN

struct HomeDigestResponse: Codable, Sendable {
    let schemaVersion: String?
    let status: String
    let generatedAt: String?
    let coverage: HomeCoverage?
    let companies: [HomeCompanyDTO]
    let popular: [String]?
}

struct HomeCoverage: Codable, Sendable {
    let count: Int
    let lastUpdatedAt: String?
}

struct HomeCompanyDTO: Codable, Identifiable, Hashable, Sendable {
    var id: String { ticker }
    let ticker: String
    let name: String
    let nameZh: String?
    let aliases: [String]?
    let sector: String?
    let status: String?
    let latestPeriod: HomeLatestPeriod?
    let revenue: HomeRevenueDTO?
    let operatingMargin: HomeOperatingMarginDTO?
    let findingCounts: HomeFindingCounts?
    let topFindings: [HomeFindingDTO]?

    var displayName: String {
        if let zh = nameZh, !zh.isEmpty { return zh }
        return Self.chineseFallbackNames[ticker] ?? name
    }

    var formattedFiscalLabel: String {
        guard let p = latestPeriod else { return "—" }
        if let fy = p.fiscalYear, let fq = p.fiscalQuarter, p.labelSource != "unknown" {
            return "\(fy) 财年 Q\(fq)"
        }
        return p.fiscalLabel ?? p.calendarLabel ?? "—"
    }

    func matches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return true }
        if ticker.lowercased().contains(q) || name.lowercased().contains(q) || displayName.lowercased().contains(q) {
            return true
        }
        return (aliases ?? []).contains { $0.lowercased().contains(q) }
    }

    private static let chineseFallbackNames: [String: String] = [
        "NVDA": "英伟达",
        "MSFT": "微软",
        "AMZN": "亚马逊",
        "GOOGL": "谷歌",
        "META": "Meta",
        "INTC": "英特尔",
        "ORCL": "甲骨文",
        "NET": "Cloudflare",
        "CRWV": "CoreWeave",
        "NBIS": "Nebius",
        "IREN": "IREN",
        "SPCX": "SpaceX"
    ]
}

struct HomeLatestPeriod: Codable, Hashable, Sendable {
    let periodEnd: String?
    let periodStart: String?
    let fiscalLabel: String?
    let calendarLabel: String?
    let filedAt: String?
    let fiscalYear: Int?
    let fiscalQuarter: Int?
    let labelSource: String?
}

struct HomeRevenueDTO: Codable, Hashable, Sendable {
    let value: String
    let currency: String
    let yoyPct: Double?
    let qoqPct: Double?
}

struct HomeOperatingMarginDTO: Codable, Hashable, Sendable {
    let pct: Double
    let yearAgoPct: Double?
}

struct HomeFindingCounts: Codable, Hashable, Sendable {
    let risk: Int
    let strength: Int
    let shift: Int
    let watch: Int
}

struct HomeFindingDTO: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let severity: Int
    let title: String
    let periodEnd: String?
}

// MARK: - 2. /api/business/v1/research & /api/business/v1/research/:id

struct PublicResearchListResponse: Codable, Sendable {
    let status: String
    let reports: [PublicReportSummaryDTO]
}

struct PublicReportScopeDTO: Codable, Hashable, Sendable {
    let regions: [String]?
    let currency: String?
    let industryId: String?
    let description: String?
}

struct PublicReportSummaryDTO: Codable, Identifiable, Hashable, Sendable {
    var id: String { "\(reportId):\(version)" }
    let reportId: String
    let version: String
    let type: String // "macro" | "industry"
    let title: String
    let language: String?
    let scope: PublicReportScopeDTO?
    let asOf: String?
    let publishedAt: String?
    let freshnessStatus: String?
    let coverage: String?
    let summary: String
    let changes: [String]?

    var isMacro: Bool { type.lowercased() == "macro" }

    var scopeLine: String {
        let regions = (scope?.regions ?? []).prefix(1).joined()
        let ccy = scope?.currency ?? ""
        if !regions.isEmpty && !ccy.isEmpty { return "\(regions) · \(ccy)" }
        if let ind = scope?.industryId, !ind.isEmpty { return ind.uppercased() }
        return isMacro ? "宏观基线" : "行业研究"
    }

    var shortDate: String {
        String((asOf ?? publishedAt ?? "").prefix(10))
    }

    var freshnessLabel: String {
        switch freshnessStatus {
        case "valid": "有效"
        case "updating": "更新中"
        case "review_required": "待复核"
        case "stale": "需关注更新"
        default: "已发布"
        }
    }
}

struct PublicResearchDetailResponse: Codable, Sendable {
    let status: String
    let report: PublicReportDetailDTO?
}

struct PublicReportDetailDTO: Codable, Sendable {
    let reportId: String
    let version: String
    let type: String
    let title: String
    let asOf: String?
    let summary: String
    let bodyMarkdown: String?
}

// MARK: - 3. /api/business/v1/companies/:ticker/valuation

struct ValuationAPIResponse: Codable, Sendable {
    let schemaVersion: String?
    let ticker: String
    let availability: String
    let report: ValuationReportDTO?
    let priceGuide: ValuationPriceGuideDTO?
    let priceImpact: ValuationPriceImpactDTO?
    let outdated: Bool?
}

struct ValuationQuoteDTO: Codable, Sendable {
    let price: Double?
    let currency: String?
    let priceDate: String?
    let source: String?
    let usable: Bool?
}

struct ValuationPriceGuideDTO: Codable, Sendable {
    let status: String?
    let quote: ValuationQuoteDTO?
    let position: String?
    let gapToLow: Double?
    let gapToBase: Double?
    let gapToHigh: Double?
    let discountToBase: Double?
    let reason: String?
}

struct ValuationPriceImpactDTO: Codable, Sendable {
    let currency: String?
    let modelType: String?
    let valuationAsOf: String?
    let referenceQuote: ValuationQuoteDTO?
    let latestQuote: ValuationQuoteDTO?
    let scenarios: [ValuationScenarioImpactDTO]?
    let counterEvidence: [String]?
    let nextChecks: [String]?
    let freshnessStatus: String?
}

struct ValuationScenarioImpactDTO: Codable, Identifiable, Sendable {
    var id: String { key }
    let key: String // "bear" | "base" | "bull"
    let perShare: Double?
    let gapToReference: Double?
    let narrative: String?
    let triggers: [String]?
    let invalidation: [String]?

    var labelZh: String {
        switch key {
        case "bear": "熊市情景"
        case "base": "基准情景"
        case "bull": "牛市情景"
        default: key.uppercased()
        }
    }
}

struct ValuationReportDTO: Codable, Sendable {
    let ticker: String
    let companyName: String?
    let currency: String?
    let researchAsOf: String?
    let financialPeriodEnd: String?
    let verdict: String?
    let weightedScore: Double?
    let confidence: String?
    let quote: ValuationQuoteDTO?
    let dimensions: [ValuationDimensionDTO]?
    let sections: ValuationSectionsDTO?
    let model: ValuationModelDTO?
}

struct ValuationDimensionDTO: Codable, Identifiable, Sendable {
    var id: String { key }
    let key: String
    let score: Double
    let confidence: String?
    let rationale: String?

    var titleZh: String {
        switch key {
        case "businessQuality": "商业模式质量"
        case "growthExecution": "增长与兑现"
        case "valuationSafety": "估值安全边际"
        case "mispricingCatalysts": "预期差与催化"
        case "financialResilience": "财务韧性"
        default: key
        }
    }
}

struct ValuationSectionsDTO: Codable, Sendable {
    let summary: String?
    let thesis: String?
}

struct ValuationModelDTO: Codable, Sendable {
    let modelType: String?
    let currency: String?
    let range: ValuationRangeDTO?
    let fairValueRange: ValuationFairValueRangeDTO?
}

struct ValuationRangeDTO: Codable, Sendable {
    let low: Double?
    let base: Double?
    let high: Double?
    let expected: Double?
    let price: Double?
}

struct ValuationFairValueRangeDTO: Codable, Sendable {
    let status: String?
    let kind: String?
    let low: Double?
    let base: Double?
    let high: Double?
    let rationale: String?
}

// MARK: - 4. /api/business/v1/companies/:ticker/filings & /events

struct FilingDigestsResponse: Codable, Sendable {
    let status: String?
    let filings: FilingDigestsPayload?
}

// MARK: - 4b. /api/business/v1/companies/:ticker/filings/:accession（线上单篇财报/公告完整文章）

struct FilingDetailAPIResponse: Codable, Sendable {
    let ticker: String?
    let filing: FilingDetailRecordDTO?
    let artifact: PublishedArtifactDTO?
}

struct FilingDetailRecordDTO: Codable, Sendable {
    let accessionNumber: String?
    let form: String?
    let filingDate: String?
    let edgarUrl: String?
    let summary: FilingDetailSummaryDTO?
}

struct FilingDetailSummaryDTO: Codable, Sendable {
    let headline: String?
    let analystView: String?
    let report: String?
}

struct PublishedArtifactDTO: Codable, Sendable {
    let id: String?
    let title: String?
    let html: String?
    let css: String?
    let publishedAt: String?
    let lang: String?
}

struct FilingDigestsPayload: Codable, Sendable {
    let ticker: String?
    let filings: [PublicFilingDigestDTO]
}

struct PublicFilingDigestDTO: Codable, Identifiable, Sendable {
    var id: String { accessionNumber }
    let accessionNumber: String
    let form: String
    let filingDate: String
    let reportDate: String?
    let periodEnd: String?
    let periodLabel: String?
    let fiscalYear: Int?
    let fiscalQuarter: Int?
    let date: String?
    let headline: String?
    let analystView: String?
    let risks: [String]?
    let guidance: [String]?
    let edgarUrl: String?
}

struct EventsAPIResponse: Codable, Sendable {
    let status: String?
    let events: EventsPayload?
}

struct EventsPayload: Codable, Sendable {
    let ticker: String?
    let events: [CompanyEventDTO]
}

struct CompanyEventDTO: Codable, Identifiable, Sendable {
    let id: String
    let ticker: String?
    let form: String
    let filedAt: String
    let eventDate: String?
    let eventClass: String?
    let description: String?
    let title: String?
    let importance: String?
    let edgarUrl: String?
    let summary: EventSummaryDTO?
    let insider: InsiderTransactionDTO?

    enum CodingKeys: String, CodingKey {
        case id, ticker, form, filedAt, eventDate
        case eventClass = "class"
        case description, title, importance, edgarUrl, summary, insider
    }
}

struct EventSummaryDTO: Codable, Sendable {
    let headline: String?
    let analystView: String?
}

struct InsiderTransactionDTO: Codable, Sendable {
    let ownerName: String
    let title: String?
    let isDirector: Bool?
    let isOfficer: Bool?
    let rule10b51: Bool?
    let sold: InsiderAggregateDTO?
    let bought: InsiderAggregateDTO?
}

struct InsiderAggregateDTO: Codable, Sendable {
    let shares: Double?
    let proceeds: Double?
    let cost: Double?
    let averagePrice: Double?
}

// MARK: - 5. 统一前端展示用的公司动态条目（对齐网页 RailStream）

enum StreamFilterCategory: String, CaseIterable, Identifiable {
    case reports, management
    var id: String { rawValue }

    var label: String {
        switch self {
        case .reports: "财报"
        case .management: "管理层动态"
        }
    }
}

struct CompanyStreamItem: Identifiable, Hashable, Sendable {
    let id: String
    let accessionNumber: String?
    let category: StreamFilterCategory
    let iconName: String
    let isNegativeSignal: Bool
    let title: String
    let metaLine: String
    let sortDate: String
    let quarterHeading: String
    let periodEndLabel: String
    let detailBody: String
    let sourceLabel: String
    let edgarUrl: String?
}

struct CompanyStreamQuarterSection: Identifiable, Hashable, Sendable {
    var id: String { "\(quarterHeading)-\(periodEndLabel)" }
    let quarterHeading: String
    let periodEndLabel: String
    let items: [CompanyStreamItem]
}

// MARK: - 6. 数字与日期格式化工具

enum FinanceFormat {
    static func compactMoney(_ rawValue: String?, currency: String = "USD") -> String {
        guard let rawValue, let amount = Double(rawValue) else { return "—" }
        return compactMoney(amount, currency: currency)
    }

    static func compactMoney(_ amount: Double, currency: String = "USD") -> String {
        let symbol = currency == "USD" ? "$" : "\(currency) "
        let absVal = abs(amount)
        let sign = amount < 0 ? "−" : ""
        if absVal >= 1_000_000_000_000 {
            return String(format: "%@%@%.2fT", sign, symbol, absVal / 1_000_000_000_000)
        } else if absVal >= 1_000_000_000 {
            return String(format: "%@%@%.2fB", sign, symbol, absVal / 1_000_000_000)
        } else if absVal >= 1_000_000 {
            return String(format: "%@%@%.1fM", sign, symbol, absVal / 1_000_000)
        }
        return String(format: "%@%@%.0f", sign, symbol, absVal)
    }

    static func price(_ value: Double?, currency: String = "USD") -> String {
        guard let value else { return "—" }
        let symbol = currency == "USD" ? "$" : "\(currency) "
        return String(format: "%@%.2f", symbol, value)
    }

    static func signedPercent(_ pct: Double?) -> String {
        guard let pct else { return "—" }
        let sign = pct > 0 ? "+" : (pct < 0 ? "−" : "")
        return "\(sign)\(String(format: "%.1f%%", abs(pct)))"
    }

    static func shortMonthDay(_ isoDate: String) -> String {
        guard isoDate.count >= 10 else { return isoDate }
        let start = isoDate.index(isoDate.startIndex, offsetBy: 5)
        let end = isoDate.index(isoDate.startIndex, offsetBy: 10)
        return isoDate[start..<end].replacingOccurrences(of: "-", with: ".")
    }

    static func dotDate(_ isoDate: String) -> String {
        String(isoDate.prefix(10)).replacingOccurrences(of: "-", with: ".")
    }
}
