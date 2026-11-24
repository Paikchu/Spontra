import Foundation

enum FinancialStatement: String, CaseIterable, Identifiable, Sendable {
    case income, balance, cash

    var id: Self { self }
    var label: String {
        switch self {
        case .income: "利润表"
        case .balance: "资产负债表"
        case .cash: "现金流量表"
        }
    }
}

struct StatementPeriod: Identifiable, Sendable {
    let periodEnd: String
    let periodLabel: String
    let basis: String
    let currency: String
    let headline: String
    let amount: String
    let flows: [StatementSankey]
    let sources: [URL]

    var id: String { periodEnd }

    init(periodEnd: String, periodLabel: String? = nil, basis: String, currency: String,
         headline: String, amount: Double, flows: [StatementSankey], sources: [URL]) {
        self.periodEnd = periodEnd
        self.periodLabel = periodLabel ?? FinanceFormat.dotDate(periodEnd)
        self.basis = basis
        self.currency = currency
        self.headline = headline
        self.amount = FinanceFormat.compactMoney(amount, currency: currency)
        self.flows = flows
        self.sources = sources
    }
}

struct StatementSankey: Sendable {
    enum Tone: Sendable {
        case primary, funding, spending, other
    }

    struct Node: Sendable {
        let label: String
        let amount: Double
        let tone: Tone
    }

    let sources: [Node]
    let uses: [Node]
    let total: Double

    // A negative term balances the opposite side of the accounting identity.
    init?(inputs: [Node], outputs: [Node], tolerance: Double) {
        sources = inputs.filter { $0.amount > 0 } + outputs.filter { $0.amount < 0 }
        uses = outputs.filter { $0.amount > 0 } + inputs.filter { $0.amount < 0 }
        let sourcesTotal = sources.reduce(0) { $0 + abs($1.amount) }
        let usesTotal = uses.reduce(0) { $0 + abs($1.amount) }
        guard sourcesTotal > 0, usesTotal > 0, abs(sourcesTotal - usesTotal) <= tolerance else { return nil }
        total = max(sourcesTotal, usesTotal)
    }
}

struct IncomeStatementPublication: Decodable {
    let status: String
    let flow: QuarterlyStatements?
    let reports: QuarterlyStatements?

    struct QuarterlyStatements: Decodable {
        let quarters: [Quarter]
    }

    func periods() -> [StatementPeriod] {
        guard status == "ready", let flow else { return [] }
        var quarters: [String: Quarter] = [:]
        for quarter in (reports?.quarters ?? []) + flow.quarters {
            quarters[quarter.periodEnd] = quarter
        }
        return quarters.values.compactMap { $0.statement() }.sorted { $0.periodEnd > $1.periodEnd }
    }

    struct Quarter: Decodable {
        struct Amount: Decodable { let value: String? }
        struct Segment: Decodable { let name: String; let revenue: Amount? }
        struct Component: Decodable { let name: String; let amount: Amount }
        struct Source: Decodable { let url: URL }

        let periodEnd: String
        let fiscalYear: Int?
        let fiscalQuarter: Int?
        let currency: String
        let scale: Double
        let incomeModel: String?
        let figures: [String: Amount]
        let segments: [Segment]
        let segmentsComplete: Bool
        let revenueAdjustments: [Component]?
        let afterTaxComponents: [Component]?
        let sources: [Source]

        private typealias Node = StatementSankey.Node

        private func value(_ key: String) -> Double? {
            figures[key]?.value.flatMap(Double.init).map { $0 * scale }
        }

        private func node(_ key: String, _ label: String, negative: String? = nil,
                          tone: StatementSankey.Tone = .primary) -> Node? {
            value(key).map { amount in
                Node(label: amount < 0 ? negative ?? label : label, amount: amount,
                     tone: amount < 0 && tone == .primary ? .spending : tone)
            }
        }

        func statement() -> StatementPeriod? {
            let financial = incomeModel == "financial" || incomeModel == "insurance"
            guard let revenue = node("revenue", incomeModel == "financial" ? "净营收" : "营收"),
                  let net = node("net", "净利润", negative: "净亏损") else { return nil }
            let gross = node("gross", "毛利", negative: "毛亏损")
            let operating = node("operating", "营业利润", negative: "营业亏损")
            let pretax = node("pretax", "税前利润", negative: "税前亏损")
            let other = node("other", "营业外净收入", negative: "营业外净支出", tone: .other)
            let expenses = node("operatingExpenses", financial ? "总费用" : "营业费用", tone: .spending)
            let taxes = node("tax", "所得税", negative: "所得税收益", tone: .spending)
            let tolerance = max(scale * 0.000001, abs(revenue.amount) * 1e-9)
            var flows: [StatementSankey] = []

            func append(_ inputs: [Node?], _ outputs: [Node?]) {
                let source = inputs.compactMap { $0 }
                let target = outputs.compactMap { $0 }
                if source.count == inputs.count, target.count == outputs.count,
                   let flow = StatementSankey(inputs: source, outputs: target, tolerance: tolerance) {
                    flows.append(flow)
                }
            }

            if segmentsComplete, segments.count > 1 {
                let segmentNodes = segments.map { segment in
                    segment.revenue?.value.flatMap(Double.init).map {
                        Node(label: segment.name, amount: $0 * scale, tone: .funding)
                    }
                }
                let adjustments = (revenueAdjustments ?? []).map { component in
                    component.amount.value.flatMap(Double.init).map {
                        Node(label: component.name, amount: $0 * scale, tone: .other)
                    }
                }
                append(segmentNodes + adjustments, [revenue])
            }

            if financial {
                append(incomeModel == "insurance" ? [revenue, other] : [revenue], [pretax, expenses])
            } else {
                if incomeModel == "direct_operating" {
                    append([revenue], [operating, expenses])
                } else {
                    append([revenue], [gross, node("cost", "营业成本", tone: .spending)])
                    append([gross], [operating, expenses])
                }
                append([operating, other], [pretax])
            }

            let afterTax = (afterTaxComponents ?? []).map { component in
                component.amount.value.flatMap(Double.init).map {
                    Node(label: component.name, amount: $0 * scale, tone: .other)
                }
            }
            append([pretax] + afterTax, [net, taxes])

            guard !flows.isEmpty else { return nil }
            let fiscalLabel = fiscalYear.flatMap { year in fiscalQuarter.map { "FY\(year) Q\($0)" } }
            return StatementPeriod(
                periodEnd: periodEnd, periodLabel: fiscalLabel, basis: "单季", currency: currency,
                headline: net.label, amount: net.amount, flows: flows, sources: sources.map(\.url)
            )
        }
    }
}

struct CapitalStatementPublication: Decodable {
    let status: String
    let capital: Capital?

    struct Capital: Decodable {
        let quarters: [Quarter]
    }

    struct Quarter: Decodable {
        let periodEnd: String
        let balanceSheet: Balance?
        let cashFlow: CashFlow?
        let yearToDate: CashFlow?
    }

    struct Line: Decodable {
        let group: String
        let value: String
    }

    struct Source: Decodable { let url: URL }

    struct Balance: Decodable {
        struct Totals: Decodable { let assets: String }
        let asOf: String
        let currency: String
        let assets: [Line]
        let liabilities: [Line]
        let equity: [Line]
        let totals: Totals
        let source: Source
    }

    struct CashFlow: Decodable {
        struct Section: Decodable {
            let total: String
            let lines: [Line]?
        }

        let periodStart: String
        let periodEnd: String
        let currency: String
        let basis: String
        let operating: Section
        let investing: Section
        let financing: Section
        let fxEffect: String?
        let netChange: String
        let sources: [Source]
    }

    struct Periods: Sendable {
        var balance: [StatementPeriod] = []
        var cash: [StatementPeriod] = []
    }

    private typealias Node = StatementSankey.Node

    func periods() -> Periods {
        guard status == "ready", let capital else { return Periods() }
        var result = Periods()
        for quarter in capital.quarters.sorted(by: { $0.periodEnd > $1.periodEnd }) {
            if let balance = quarter.balanceSheet, let period = Self.balancePeriod(balance) {
                result.balance.append(period)
            }
            if let cash = quarter.cashFlow ?? quarter.yearToDate,
               let period = Self.cashPeriod(cash, cumulative: quarter.cashFlow == nil) {
                result.cash.append(period)
            }
        }
        return result
    }

    private static func balancePeriod(_ balance: Balance) -> StatementPeriod? {
        guard let assets = Double(balance.totals.assets) else { return nil }
        let liabilities = grouped(balance.liabilities, labels: [
            "debt": "债务", "leases": "租赁负债", "customerAdvances": "客户预付款",
            "payables": "应付款及预提费用", "deferredTax": "递延税负债", "other": "其他负债"
        ], tone: .funding)
        let equity = grouped(balance.equity, labels: [
            "paidIn": "实收资本", "retained": "留存收益", "otherEquity": "其他权益",
            "noncontrolling": "非控股权益", "redeemable": "可赎回权益"
        ], negative: [
            "retained": "累计亏损", "paidIn": "库存股及资本抵减", "otherEquity": "其他权益抵减"
        ], tone: .funding, separateSigns: true)
        let holdings = grouped(balance.assets, labels: [
            "cash": "现金及短期投资", "receivables": "应收账款", "inventory": "存货",
            "productive": "固定资产", "leaseAssets": "使用权资产", "intangibles": "商誉及无形资产",
            "investments": "长期投资", "other": "其他资产"
        ], tone: .primary)

        guard let flow = StatementSankey(inputs: liabilities + equity, outputs: holdings,
                                         tolerance: 3 * max(1, abs(assets) * 1e-9)) else { return nil }
        return StatementPeriod(periodEnd: balance.asOf, basis: "期末", currency: balance.currency,
                               headline: "总资产", amount: assets, flows: [flow], sources: [balance.source.url])
    }

    private static func cashPeriod(_ cash: CashFlow, cumulative: Bool) -> StatementPeriod? {
        guard let operating = Double(cash.operating.total), let net = Double(cash.netChange) else { return nil }
        let investing = grouped(cash.investing.lines ?? [], labels: [
            "capex": "设备出售", "acquisitions": "业务出售", "investments": "收回投资", "other": "其他投资流入"
        ], negative: [
            "capex": "资本开支", "acquisitions": "收购", "investments": "投资支出", "other": "其他投资流出"
        ], tone: .other)
        let financing = grouped(cash.financing.lines ?? [], labels: [
            "debtIssued": "新增借款", "equityIssued": "股权融资", "other": "其他筹资活动"
        ], negative: [
            "debtRepaid": "偿还债务", "equityIssued": "股权相关支出", "buybacks": "股票回购",
            "dividends": "分红", "leasePrincipal": "融资租赁付款"
        ], tone: .funding)
        let fx = cash.fxEffect.flatMap(Double.init) ?? 0
        let cashItems = [
            Node(label: operating >= 0 ? "经营现金流" : "经营现金消耗", amount: operating,
                 tone: operating >= 0 ? .primary : .spending),
            Node(label: "汇率影响", amount: fx, tone: .other)
        ]
        let investingNodes = cash.investing.lines == nil ? sectionTotal(cash.investing, "投资活动") : investing
        let financingNodes = cash.financing.lines == nil ? sectionTotal(cash.financing, "筹资活动") : financing

        guard let flow = StatementSankey(
            inputs: cashItems + financingNodes + investingNodes,
            outputs: [Node(label: net >= 0 ? "现金增加" : "动用现金储备", amount: net, tone: .primary)],
            tolerance: 3 * max(1, abs(net) * 1e-9)
        ) else { return nil }
        let basis = cumulative ? "累计" : cash.basis == "derived" ? "单季 · 由累计披露推算" : "单季"
        return StatementPeriod(periodEnd: cash.periodEnd,
                               basis: "\(basis) · \(FinanceFormat.dotDate(cash.periodStart)) 起",
                               currency: cash.currency, headline: "现金净变动", amount: net,
                               flows: [flow], sources: cash.sources.map(\.url))
    }

    private static func grouped(_ lines: [Line], labels: [String: String], negative: [String: String] = [:],
                                tone: StatementSankey.Tone, separateSigns: Bool = false) -> [Node] {
        let groups = Dictionary(grouping: lines, by: \.group)
        return groups.flatMap { group, lines -> [Node] in
            let amounts = lines.compactMap { Double($0.value) }
            let totals = separateSigns
                ? [amounts.filter { $0 > 0 }.reduce(0, +), amounts.filter { $0 < 0 }.reduce(0, +)]
                : [amounts.reduce(0, +)]
            return totals.filter { $0 != 0 }.map { value in
                let label = (value < 0 ? negative[group] : nil) ?? labels[group] ?? Self.cashGroupLabels[group] ?? group
                return Node(label: label, amount: value, tone: value < 0 ? .spending : tone)
            }
        }.sorted { abs($0.amount) == abs($1.amount) ? $0.label < $1.label : abs($0.amount) > abs($1.amount) }
    }

    private static let cashGroupLabels = [
        "debtIssued": "借款", "debtRepaid": "偿债", "buybacks": "股票回购",
        "dividends": "分红", "leasePrincipal": "租赁融资"
    ]

    private static func sectionTotal(_ section: CashFlow.Section, _ label: String) -> [Node] {
        guard let amount = Double(section.total) else { return [] }
        return [Node(label: label, amount: amount, tone: amount < 0 ? .spending : .funding)]
    }
}
