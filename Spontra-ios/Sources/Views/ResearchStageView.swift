import SwiftUI

enum ResearchStageKind {
    case macro, industry
}

struct ResearchStageView: View {
    @Environment(SpontraStore.self) private var store
    let kind: ResearchStageKind
    @State private var selectedSummary: PublicReportSummaryDTO?

    private var filteredReports: [PublicReportSummaryDTO] {
        switch kind {
        case .macro: store.researchReports.filter { $0.isMacro }
        case .industry: store.researchReports.filter { !$0.isMacro }
        }
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 10) {
                if store.isBootstrapping && store.researchReports.isEmpty {
                    loadingRow(kind == .macro ? "正在加载最新宏观报告..." : "正在加载最新行业报告...")
                } else if filteredReports.isEmpty {
                    emptyRow(kind == .macro ? "暂无已发布的宏观报告" : "暂无已发布的行业报告")
                } else {
                    VStack(spacing: 0) {
                        ForEach(filteredReports) { report in
                            Button {
                                selectedSummary = report
                            } label: {
                                researchRow(report)
                            }
                            .buttonStyle(.plain)

                            if report.id != filteredReports.last?.id {
                                Divider().overlay(DesignTokens.Colors.hairline)
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
            await store.refreshAll()
        }
        .fullScreenCover(item: $selectedSummary) { summary in
            ResearchArticleSheet(summary: summary)
                .environment(store)
        }
    }

    private func researchRow(_ report: PublicReportSummaryDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(report.isMacro ? "宏观" : "行业")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(report.isMacro ? DesignTokens.Colors.techCyan : DesignTokens.Colors.financialUp)

                Text("· \(report.scopeLine)")
                    .font(.caption2)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                    .lineLimit(1)

                Spacer()

                Text(report.freshnessLabel)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(DesignTokens.Colors.financialUp)
            }

            Text(report.title)
                .font(.subheadline.weight(.semibold))
                .fontDesign(.serif)
                .foregroundStyle(DesignTokens.Colors.textPrimary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            Text(report.summary)
                .font(.footnote)
                .foregroundStyle(DesignTokens.Colors.textSecondary)
                .lineLimit(3)
                .lineSpacing(3)
                .multilineTextAlignment(.leading)

            HStack {
                Text("截至 \(report.shortDate)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(DesignTokens.Colors.textTertiary)

                if report.coverage == "limited" {
                    Text("· 有限样本")
                        .font(.caption2)
                        .foregroundStyle(DesignTokens.Colors.financialShift)
                }

                Spacer()

                HStack(spacing: 3) {
                    Text("阅读全文")
                        .font(.caption2.weight(.semibold))
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(DesignTokens.Colors.techCyan)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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

// MARK: - 宏观 / 行业研报全文阅读 Sheet

struct ResearchArticleSheet: View {
    @Environment(SpontraStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let summary: PublicReportSummaryDTO

    @State private var detail: PublicReportDetailDTO?
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 6) {
                        Text(summary.isMacro ? "宏观报告" : "行业报告")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(DesignTokens.Colors.techCyan)
                        Text("· 截至 \(summary.shortDate)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                    }

                    Text(summary.title)
                        .font(.headline.weight(.bold))
                        .fontDesign(.serif)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)

                    Text(summary.summary)
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineSpacing(4)

                    Divider().overlay(DesignTokens.Colors.hairline)

                    if isLoading {
                        HStack(spacing: 10) {
                            ProgressView().tint(DesignTokens.Colors.techCyan)
                            Text("正在加载完整研究正文...")
                                .font(.footnote)
                                .foregroundStyle(DesignTokens.Colors.textSecondary)
                        }
                        .padding(.top, 4)
                    } else if let bodyText = detail?.bodyMarkdown, !bodyText.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(parsedParagraphs(bodyText).enumerated()), id: \.offset) { _, block in
                                if block.isHeading {
                                    Text(block.text)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                                        .padding(.top, 6)
                                } else {
                                    Text(block.text)
                                        .font(.footnote)
                                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                                        .lineSpacing(4)
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(DesignTokens.Colors.canvas.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(DesignTokens.Colors.techCyan)
                        .fontWeight(.semibold)
                }
            }
            .task {
                isLoading = true
                detail = await store.loadResearchDetail(for: summary)
                isLoading = false
            }
        }
    }

    private func parsedParagraphs(_ markdown: String) -> [(isHeading: Bool, text: String)] {
        let rawBlocks = markdown
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .prefix(40)

        return rawBlocks.map { block in
            if block.hasPrefix("#") {
                let cleaned = block.drop(while: { $0 == "#" || $0 == " " })
                return (true, String(cleaned))
            }
            let cleaned = block
                .replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "  ", with: " ")
            return (false, cleaned)
        }
    }
}
