import SwiftUI

@main
struct SpontraIOSApp: App {
    @State private var store = SpontraStore()

    var body: some Scene {
        WindowGroup {
            RootWorkspaceView()
                .environment(store)
                .preferredColorScheme(store.colorSchemePreference.colorScheme)
        }
    }
}
