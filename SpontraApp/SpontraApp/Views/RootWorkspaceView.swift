import SwiftUI

struct RootWorkspaceView: View {
    @Environment(SpontraStore.self) private var store
    @State private var dragTranslation: CGFloat = 0
    @State private var isDraggingDrawer: Bool = false
    @State private var isDockedSidebarOpen = true
    @ScaledMetric(relativeTo: .headline) private var headerTitleSize: CGFloat = 18

    var body: some View {
        @Bindable var bindableStore = store

        GeometryReader { geo in
            let width = geo.size.width
            let usesSplitLayout = width > geo.size.height && width >= 620
            let drawerWidth = width * DesignTokens.Layout.sidebarWidthRatio
            let dockedWidth = min(max(width * 0.28, 188), 280)
            let progress = usesSplitLayout ? 0 : drawerProgress(width: drawerWidth)
            let isDrawerOpen = !usesSplitLayout && store.isMenuOpen

            HStack(spacing: 0) {
                if usesSplitLayout && isDockedSidebarOpen {
                    WorkspaceSidebar(
                        sidebarWidth: dockedWidth,
                        isDocked: true,
                        onClose: { toggleSidebar(docked: true) }
                    )
                    .overlay(alignment: .trailing) {
                        Rectangle()
                            .fill(DesignTokens.Colors.hairline)
                            .frame(width: 1)
                            .allowsHitTesting(false)
                    }
                    .transition(.move(edge: .leading).combined(with: .opacity))
                }

                mainContentLayer(docked: usesSplitLayout)
                    .scaleEffect(1.0 - (1.0 - DesignTokens.Motion.mainRecedeScale) * progress)
                    .blur(radius: (store.colorSchemePreference == .dark ? 42 : 30) * progress)
                    .allowsHitTesting(!isDrawerOpen)
                    .accessibilityHidden(isDrawerOpen)
            }
            .overlay(alignment: .leading) {
                if !usesSplitLayout {
                    ZStack {
                        HorizontalSidebarVeilView(isDark: store.colorSchemePreference == .dark)
                            .opacity(progress)
                            .allowsHitTesting(isDrawerOpen)
                            .onTapGesture { toggleMenu(open: false) }

                        WorkspaceSidebar(
                            sidebarWidth: drawerWidth,
                            onClose: { toggleMenu(open: false) }
                        )
                        .offset(x: -drawerWidth * (1.0 - progress))
                        .blur(radius: DesignTokens.Motion.menuEntryBlurRadius * (1.0 - progress))
                        .opacity(progress)
                        .allowsHitTesting(isDrawerOpen)
                        .accessibilityHidden(!isDrawerOpen)
                    }
                }
            }
            .background(DesignTokens.Colors.canvas.ignoresSafeArea())
            .simultaneousGesture(drawerGesture(width: drawerWidth), isEnabled: !usesSplitLayout)
            .animation(
                isDraggingDrawer ? nil : DesignTokens.Motion.transitionSpring,
                value: store.isMenuOpen
            )
            .animation(
                isDraggingDrawer ? nil : DesignTokens.Motion.transitionSpring,
                value: dragTranslation
            )
        }
        .task {
            await store.bootstrap()
        }
        .sheet(isPresented: $bindableStore.isSearchSheetPresented) {
            TickerWatchlistManagerSheet()
                .environment(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func drawerProgress(width: CGFloat) -> CGFloat {
        guard width > 0 else { return 0 }
        let base: CGFloat = store.isMenuOpen ? 1.0 : 0.0
        let delta = dragTranslation / width
        return min(max(base + delta, 0.0), 1.0)
    }

    private func drawerGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 18, coordinateSpace: .local)
            .onChanged { value in
                // 页面任意位置水平滑动均可呼出/收起侧边栏，同时避免误触垂直滚动
                guard abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                if !store.isMenuOpen {
                    guard value.translation.width > 0 else { return }
                    isDraggingDrawer = true
                    dragTranslation = value.translation.width
                } else {
                    guard value.translation.width < 0 else { return }
                    isDraggingDrawer = true
                    dragTranslation = value.translation.width
                }
            }
            .onEnded { value in
                guard isDraggingDrawer else { return }
                let predicted = value.predictedEndTranslation.width
                isDraggingDrawer = false
                withAnimation(DesignTokens.Motion.transitionSpring) {
                    if !store.isMenuOpen {
                        if value.translation.width > width * 0.22 || predicted > width * 0.40 {
                            store.isMenuOpen = true
                            DesignTokens.lightImpact()
                        }
                    } else {
                        if value.translation.width < -width * 0.22 || predicted < -width * 0.40 {
                            store.isMenuOpen = false
                            DesignTokens.lightImpact()
                        }
                    }
                    dragTranslation = 0
                }
            }
    }

    // MARK: - 主视图容器（移除底部 Dock，保留上下渐进模糊消失与顶部悬浮栏）

    private func mainContentLayer(docked: Bool) -> some View {
        ZStack(alignment: .top) {
            DesignTokens.Colors.canvas.ignoresSafeArea()

            // 主舞台内容区（根据侧边栏所选：宏观 / 行业 / 公司）
            Group {
                switch store.activeDestination {
                case .macro:
                    ResearchStageView(kind: .macro)
                case .industry:
                    ResearchStageView(kind: .industry)
                case .company:
                    switch store.companySubView {
                    case .stream:
                        CompanyStreamStageView()
                    case .statement(let statement):
                        CompanyStatementsStageView(ticker: store.selectedTicker, statement: statement)
                    case .valuation:
                        ValuationStageView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 上方渐进模糊消失层
            VStack(spacing: 0) {
                ProgressiveEdgeBlurView(
                    edge: .top,
                    height: docked
                        ? DesignTokens.Layout.topSafeClearance
                        : DesignTokens.Layout.topProgressiveBlurHeight
                )
                Spacer()
            }
            .ignoresSafeArea(edges: .top)

            // 顶部悬浮栏（已移除蓝色光晕，整体上移更贴近灵动岛）
            topFloatingHeader(docked: docked)
        }
    }

    private func topFloatingHeader(docked: Bool) -> some View {
        let isCompany = store.activeDestination == .company
        let currentTicker = store.selectedTicker
        let headerTitle: String = switch store.activeDestination {
        case .macro: "宏观"
        case .industry: "行业"
        case .company: currentTicker
        }

        return HStack(alignment: .center) {
            Button {
                toggleSidebar(docked: docked)
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: docked ? "sidebar.left" : "line.3.horizontal")
                        .font(.system(size: docked ? 17 : 16, weight: .semibold))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .frame(
                            width: DesignTokens.Layout.floatingButtonSize,
                            height: DesignTokens.Layout.floatingButtonSize
                        )
                        .liquidGlass(Circle())

                    if !docked {
                        Circle()
                            .fill(DesignTokens.Colors.techCyan)
                            .frame(width: 7, height: 7)
                            .offset(x: -10, y: 11)
                    }
                }
            }
            .buttonStyle(LiquidGlassPressStyle())
            .accessibilityLabel(docked && isDockedSidebarOpen ? "收起侧边栏" : "打开侧边栏")

            Spacer()

            // 正中：横向「圆角方形公司 Logo + Ticker 名称」（对齐上传参考图）
            Button {
                toggleSidebar(docked: docked)
            } label: {
                HStack(spacing: 8) {
                    if isCompany {
                        CompanyLogoView(ticker: currentTicker, size: 28, cornerRadius: 8)
                    } else {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            DesignTokens.Colors.techBlue,
                                            DesignTokens.Colors.techCyan.opacity(0.85)
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 28, height: 28)

                            Image(systemName: store.activeDestination == .macro ? "globe.asia.australia.fill" : "square.grid.2x2.fill")
                                .font(.system(size: docked ? 15 : 14, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }

                    Text(headerTitle)
                        .font(docked ? .system(size: headerTitleSize, weight: .bold).monospacedDigit() : .headline.weight(.bold).monospacedDigit())
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 12)
                .frame(height: DesignTokens.Layout.floatingButtonSize)
                .contentShape(Rectangle())
            }
            .buttonStyle(LiquidGlassPressStyle())
            .accessibilityLabel("当前页面：\(headerTitle)")

            Spacer()

            // 右上：自选星标 / 搜索公司
            Button {
                if isCompany {
                    store.toggleWatchlist(currentTicker)
                } else {
                    store.isSearchSheetPresented = true
                }
            } label: {
                let starred = store.isWatched(currentTicker)
                Image(systemName: isCompany ? (starred ? "star.fill" : "star") : "magnifyingglass")
                    .font(.system(size: docked ? 17 : 16, weight: .semibold))
                    .foregroundStyle(
                        isCompany && starred
                            ? DesignTokens.Colors.techCyan
                            : DesignTokens.Colors.textPrimary
                    )
                    .frame(
                        width: DesignTokens.Layout.floatingButtonSize,
                        height: DesignTokens.Layout.floatingButtonSize
                    )
                    .liquidGlass(Circle())
            }
            .buttonStyle(LiquidGlassPressStyle())
            .accessibilityLabel(isCompany ? "收藏或取消自选" : "搜索公司")
        }
        .padding(.horizontal, DesignTokens.Layout.horizontalPadding)
        .padding(.top, docked ? 4 : -6)
    }

    private func toggleSidebar(docked: Bool) {
        if docked {
            withAnimation(DesignTokens.Motion.transitionSpring) {
                isDockedSidebarOpen.toggle()
            }
        } else {
            toggleMenu(open: true)
        }
    }

    private func toggleMenu(open: Bool) {
        withAnimation(DesignTokens.Motion.transitionSpring) {
            store.isMenuOpen = open
        }
    }
}

// MARK: - 真实公司 Logo 图标组件（复用网页端 CompanyMark.tsx 同源官方 Logo，圆角方形）

struct CompanyLogoView: View {
    let ticker: String
    var size: CGFloat = 28
    var cornerRadius: CGFloat = 8

    private var logoURL: URL? {
        let encoded = ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
        return URL(string: "https://images.financialmodelingprep.com/symbol/\(encoded).png")
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            shape
                .fill(Color.white)
                .frame(width: size, height: size)

            AsyncImage(url: logoURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .padding(size * 0.14)
                case .failure, .empty:
                    monogramFallback(shape: shape)
                @unknown default:
                    monogramFallback(shape: shape)
                }
            }
            .frame(width: size, height: size)
            .clipShape(shape)
        }
        .overlay(
            shape
                .strokeBorder(DesignTokens.Colors.glassBorder, lineWidth: 0.75)
        )
    }

    private func monogramFallback(shape: RoundedRectangle) -> some View {
        ZStack {
            shape
                .fill(
                    LinearGradient(
                        colors: [DesignTokens.Colors.techBlue, DesignTokens.Colors.techCyan.opacity(0.85)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(String(ticker.prefix(2)))
                .font(.system(size: max(9, size * 0.34), weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(.white)
        }
    }
}

// MARK: - 公司页内切换栏

struct CompanyInlineModeBar: View {
    @Environment(SpontraStore.self) private var store

    var body: some View {
        ViewThatFits(in: .horizontal) {
            tabs.fixedSize(horizontal: true, vertical: false)
            ScrollView(.horizontal, showsIndicators: false) { tabs }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tabs: some View {
        HStack(spacing: 10) {
            ForEach(CompanySubView.allCases) { tab in
                let isSelected = store.companySubView == tab
                Button {
                    guard store.companySubView != tab else { return }
                    DesignTokens.selectionTick()
                    withAnimation(DesignTokens.Motion.transitionSpring) {
                        store.companySubView = tab
                    }
                } label: {
                    VStack(spacing: 5) {
                        Text(tab.label)
                            .font(.footnote.weight(isSelected ? .bold : .medium))
                            .foregroundStyle(
                                isSelected
                                    ? DesignTokens.Colors.textPrimary
                                    : DesignTokens.Colors.textSecondary
                            )
                        Capsule()
                            .fill(isSelected ? DesignTokens.Colors.techCyan : Color.clear)
                            .frame(width: 22, height: 2)
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}

#Preview("Dark") {
    RootWorkspaceView()
        .environment(SpontraStore())
        .preferredColorScheme(.dark)
}

#Preview("Light") {
    RootWorkspaceView()
        .environment(SpontraStore())
        .preferredColorScheme(.light)
}
