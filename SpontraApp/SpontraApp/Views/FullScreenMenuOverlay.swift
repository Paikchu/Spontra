import SwiftUI

struct WorkspaceSidebar: View {
    @Environment(SpontraStore.self) private var store
    @ScaledMetric(relativeTo: .headline) private var primaryTitleSize: CGFloat = 19
    @ScaledMetric(relativeTo: .subheadline) private var companyTitleSize: CGFloat = 16
    let sidebarWidth: CGFloat
    var isDocked = false
    let onClose: () -> Void

    var body: some View {
        if isDocked {
            VStack(spacing: 0) {
                sidebarList

                Divider().overlay(DesignTokens.Colors.hairline)

                bottomBar
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
            .frame(width: sidebarWidth)
            .background(DesignTokens.Colors.canvas)
        } else {
            ZStack(alignment: .bottom) {
                HStack(spacing: 0) {
                    sidebarList
                        .frame(width: sidebarWidth)
                        .mask(
                            VStack(spacing: 0) {
                                Color.black
                                LinearGradient(
                                    colors: [Color.black, Color.clear],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                                .frame(height: 96)
                            }
                            .ignoresSafeArea(edges: .bottom)
                        )

                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onClose)
                }

                bottomBar
                    .padding(.horizontal, 26)
                    .padding(.bottom, 16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var bottomBar: some View {
        MenuBottomFloatingBar(
            onAddWatchlist: { store.isSearchSheetPresented = true },
            onToggleTheme: { store.toggleColorScheme() }
        )
    }

    private var sidebarList: some View {
        let companyLabelLayout = isDocked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(spacing: 10))

        return ScrollView(showsIndicators: isDocked) {
            VStack(alignment: .leading, spacing: isDocked ? 12 : 28) {
                // 顶部固定一级入口：宏观 / 行业（线性图标 + 粗体文字，垂直左对齐）
                VStack(alignment: .leading, spacing: isDocked ? 0 : 20) {
                    primaryEntryRow(
                        icon: "globe.asia.australia",
                        title: "宏观",
                        isActive: store.activeDestination == .macro
                    ) {
                        store.selectDestination(.macro)
                    }

                    primaryEntryRow(
                        icon: "square.grid.2x2",
                        title: "行业",
                        isActive: store.activeDestination == .industry
                    ) {
                        store.selectDestination(.industry)
                    }
                }

                // 中部列表区：仅保留「自选公司」纯文本列表
                VStack(alignment: .leading, spacing: isDocked ? 4 : 18) {
                    Text("自选公司")
                        .font(isDocked ? .footnote.weight(.semibold) : .caption.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.textSecondary)

                    if store.watchlistCompanies.isEmpty {
                        if store.isBootstrapping {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .scaleEffect(0.85)
                                    .tint(DesignTokens.Colors.techCyan)
                                Text("加载自选...")
                                    .font(isDocked ? .subheadline : .footnote)
                                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                            }
                        } else {
                            Button {
                                store.isSearchSheetPresented = true
                            } label: {
                                Text("点击下方添加自选公司")
                                    .font(isDocked ? .subheadline : .footnote)
                                    .foregroundStyle(DesignTokens.Colors.textTertiary)
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: isDocked ? 0 : 18) {
                            ForEach(store.watchlistCompanies) { company in
                                let isSelected = store.activeDestination == .company
                                    && company.ticker == store.selectedTicker

                                let tickerWeight: Font.Weight = isSelected ? .bold : .semibold
                                let tickerFont: Font = isDocked
                                    ? .system(size: companyTitleSize, weight: tickerWeight)
                                    : .subheadline.weight(tickerWeight)

                                Button {
                                    store.selectCompany(company.ticker)
                                } label: {
                                    HStack(spacing: 10) {
                                        CompanyLogoView(ticker: company.ticker, size: 22, cornerRadius: 6)

                                        companyLabelLayout {
                                            Text(company.ticker)
                                                .font(tickerFont.monospacedDigit())
                                                .foregroundStyle(DesignTokens.Colors.textPrimary)
                                                .fixedSize(horizontal: true, vertical: false)

                                            Text(company.displayName)
                                                .font(isDocked ? .caption : .subheadline)
                                                .foregroundStyle(
                                                    isSelected
                                                        ? DesignTokens.Colors.textPrimary
                                                        : DesignTokens.Colors.textSecondary
                                                )
                                                .lineLimit(isDocked ? 2 : 1)
                                        }
                                        .layoutPriority(1)

                                        if isSelected {
                                            Circle()
                                                .fill(DesignTokens.Colors.techBlue)
                                                .frame(width: 6, height: 6)
                                        }

                                        Spacer(minLength: 0)
                                    }
                                    .frame(minHeight: isDocked ? 44 : nil)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(isSelected ? .isSelected : [])
                                .contextMenu {
                                    Button(role: .destructive) {
                                        store.toggleWatchlist(company.ticker)
                                    } label: {
                                        Label("移出自选", systemImage: "star.slash")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.leading, isDocked ? 14 : 26)
            .padding(.trailing, 14)
            .padding(.top, isDocked ? 8 : 26)
            .padding(.bottom, isDocked ? 8 : DesignTokens.Layout.menuBottomClearance + 20)
        }
    }

    private func primaryEntryRow(
        icon: String,
        title: String,
        isActive: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: isDocked ? 19 : 18, weight: .regular))
                    .foregroundStyle(isActive ? DesignTokens.Colors.techCyan : DesignTokens.Colors.textPrimary)
                    .frame(width: 24, alignment: .center)

                Text(title)
                    .font(isDocked ? .system(size: primaryTitleSize, weight: .bold) : .headline.weight(.bold))
                    .foregroundStyle(isActive ? DesignTokens.Colors.techCyan : DesignTokens.Colors.textPrimary)

                if isActive {
                    Circle()
                        .fill(DesignTokens.Colors.techBlue)
                        .frame(width: 6, height: 6)
                }

                Spacer()
            }
            .frame(minHeight: isDocked ? 44 : nil)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

// MARK: - 侧边栏底部悬浮操作栏

struct MenuBottomFloatingBar: View {
    @Environment(SpontraStore.self) private var store
    let onAddWatchlist: () -> Void
    let onToggleTheme: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            // 左下角：原生液态玻璃科技蓝主按钮
            Button(action: onAddWatchlist) {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .bold))
                    Text("自选")
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .frame(height: DesignTokens.Layout.bottomPillHeight)
                .liquidGlass(Capsule(), tint: DesignTokens.Colors.techBlue.opacity(0.85))
            }
            .buttonStyle(LiquidGlassPressStyle())

            Spacer(minLength: 4)

            // 右下角：独立圆形毛玻璃外观切换按钮
            Button(action: onToggleTheme) {
                Image(systemName: store.colorSchemePreference.toggleIcon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .frame(
                        width: DesignTokens.Layout.bottomPillHeight,
                        height: DesignTokens.Layout.bottomPillHeight
                    )
                    .liquidGlass(Circle())
            }
            .buttonStyle(LiquidGlassPressStyle())
            .accessibilityLabel("切换深浅外观")
        }
    }
}

// MARK: - 搜索 & 管理本地自选公司 Sheet

struct TickerWatchlistManagerSheet: View {
    @Environment(SpontraStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filteredCompanies: [HomeCompanyDTO] {
        store.companies.filter { $0.matches(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                if filteredCompanies.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(filteredCompanies) { company in
                        HStack(spacing: 12) {
                            Button {
                                store.selectCompany(company.ticker)
                                dismiss()
                            } label: {
                                HStack(spacing: 10) {
                                    CompanyLogoView(ticker: company.ticker, size: 30)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(company.ticker)
                                                .font(.subheadline.weight(.bold).monospacedDigit())
                                                .foregroundStyle(DesignTokens.Colors.textPrimary)
                                            Text(company.displayName)
                                                .font(.footnote)
                                                .foregroundStyle(DesignTokens.Colors.textSecondary)
                                        }
                                        Text("\(company.formattedFiscalLabel) · 营收 \(FinanceFormat.compactMoney(company.revenue?.value, currency: company.revenue?.currency ?? "USD"))")
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(DesignTokens.Colors.textTertiary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)

                            Spacer()

                            Button {
                                store.toggleWatchlist(company.ticker)
                            } label: {
                                Image(systemName: store.isWatched(company.ticker) ? "star.fill" : "star")
                                    .font(.system(size: 16))
                                    .foregroundStyle(
                                        store.isWatched(company.ticker)
                                            ? DesignTokens.Colors.techCyan
                                            : DesignTokens.Colors.textSecondary
                                    )
                                    .frame(width: 34, height: 34)
                            }
                            .buttonStyle(.plain)
                        }
                        .listRowBackground(DesignTokens.Colors.card)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(DesignTokens.Colors.canvas.ignoresSafeArea())
            .navigationTitle("搜索与管理自选")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "输入 Ticker 或公司名（如 CRWV / NVDA）")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(DesignTokens.Colors.techCyan)
                        .fontWeight(.semibold)
                }
            }
        }
    }
}
