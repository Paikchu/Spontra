import SwiftUI
import WebKit

struct CompanyStatementsStageView: View {
    let ticker: String

    var body: some View {
        VStack(spacing: 0) {
            CompanyInlineModeBar()
                .padding(.horizontal, DesignTokens.Layout.horizontalPadding)
                .padding(.top, DesignTokens.Layout.topSafeClearance)

            CompanyStatementsPage(ticker: ticker)
                .id(ticker)
        }
    }
}

private struct CompanyStatementsPage: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var phase: LoadPhase = .loading
    @State private var attempt = 0
    let ticker: String

    enum LoadPhase {
        case loading, visible, failed
    }

    private var url: URL {
        var origin = URL(string: "https://businessview.info")!
        #if DEBUG
        if let address = ProcessInfo.processInfo.environment["SPONTRA_STATEMENTS_ORIGIN"],
           let localOrigin = URL(string: address) {
            origin = localOrigin
        }
        #endif
        let company = origin.appending(path: "companies").appending(component: ticker)
        return company.appending(queryItems: [
            URLQueryItem(name: "lang", value: "zh-CN"),
            URLQueryItem(name: "embed", value: "statements")
        ])
    }

    var body: some View {
        ZStack {
            StatementsWebView(url: url, colorScheme: colorScheme, onPhase: { phase = $0 })
                .id(attempt)
                .opacity(phase == .visible ? 1 : 0)

            switch phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("正在加载三大表")
            case .visible:
                EmptyView()
            case .failed:
                VStack(spacing: 10) {
                    Text("三大表加载失败")
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Button("重试") {
                        phase = .loading
                        attempt += 1
                    }
                    .tint(DesignTokens.Colors.techCyan)
                }
                .font(.footnote)
            }
        }
    }
}

private struct StatementsWebView: UIViewRepresentable {
    let url: URL
    let colorScheme: ColorScheme
    let onPhase: (CompanyStatementsPage.LoadPhase) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url, onPhase: onPhase)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.navigationDelegate = context.coordinator
        webView.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        let onPhase: (CompanyStatementsPage.LoadPhase) -> Void

        init(url: URL, onPhase: @escaping (CompanyStatementsPage.LoadPhase) -> Void) {
            self.url = url
            self.onPhase = onPhase
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.targetFrame?.isMainFrame == false { return .allow }
            guard let destination = action.request.url else { return .cancel }
            if action.targetFrame != nil, destination.scheme == url.scheme, destination.host == url.host,
               destination.port == url.port, destination.path == url.path {
                return .allow
            }
            if action.navigationType == .linkActivated, destination.scheme == "https" {
                _ = await UIApplication.shared.open(destination)
            }
            return .cancel
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            onPhase(.visible)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onPhase(.failed)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onPhase(.failed)
        }
    }
}
