import SwiftUI
import UIKit

// MARK: - DesignTokens（集中管理视觉、材质、模糊、缩放与弹簧物理参数）

enum DesignTokens {
    // MARK: 色彩系统（Dark Liquid Glass + Light Paper 双模式）
    enum Colors {
        static func adaptive(light: UInt, dark: UInt, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> Color {
            Color(UIColor { traits in
                let hex = traits.userInterfaceStyle == .dark ? dark : light
                let alpha = traits.userInterfaceStyle == .dark ? darkAlpha : lightAlpha
                return UIColor(
                    red: CGFloat((hex >> 16) & 0xFF) / 255,
                    green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255,
                    alpha: alpha
                )
            })
        }

        /// 画布底色：深色纯黑 #000000 / 浅色原网页温润纸白 #F3F5F2
        static let canvas = adaptive(light: 0xF3F5F2, dark: 0x000000)

        /// 内容卡片底色：深色深炭灰 #1C1C1E / 浅色纯白 #FFFFFF
        static let card = adaptive(light: 0xFFFFFF, dark: 0x1C1C1E)

        /// 次级抬升面（用于内部块、胶囊底色）
        static let elevated = adaptive(light: 0xE9EFEA, dark: 0x262629)

        /// 主文字：深色纯白 #FFFFFF / 浅色深墨绿灰 #13231F
        static let textPrimary = adaptive(light: 0x13231F, dark: 0xFFFFFF)

        /// 次级文字与分类标题：深色中性灰 #8E8E93 / 浅色 #55685F
        static let textSecondary = adaptive(light: 0x55685F, dark: 0x8E8E93)

        /// 弱化辅助文字
        static let textTertiary = adaptive(light: 0x6F7E77, dark: 0x636366)

        /// 核心高亮色：高饱和度科技蓝 / 青蓝色
        static let techBlue = adaptive(light: 0x0071E3, dark: 0x0A84FF)
        static let techCyan = adaptive(light: 0x0099CC, dark: 0x29C7FF)

        /// 财务涨跌语义色（克制、高对比度）
        static let financialUp = adaptive(light: 0x096B5F, dark: 0x79D9CD)
        static let financialDown = adaptive(light: 0xA33D34, dark: 0xF08E83)
        static let financialShift = adaptive(light: 0xB96A26, dark: 0xE8B777)

        /// 毛玻璃叠加遮罩与 0.5pt 内描边
        static let glassTint = adaptive(light: 0xFFFFFF, dark: 0x141416, lightAlpha: 0.45, darkAlpha: 0.36)
        static let glassBorder = adaptive(light: 0x0B1F1A, dark: 0xFFFFFF, lightAlpha: 0.10, darkAlpha: 0.12)
        static let hairline = adaptive(light: 0x0B1F1A, dark: 0xFFFFFF, lightAlpha: 0.08, darkAlpha: 0.09)
        static let ambientShadow = adaptive(light: 0x0B1F1A, dark: 0x000000, lightAlpha: 0.10, darkAlpha: 0.45)

        /// 菜单打开时底层主视图的暗化遮罩
        static let menuBackdropMask = adaptive(light: 0xF3F5F2, dark: 0x000000, lightAlpha: 0.62, darkAlpha: 0.55)
    }

    // MARK: 几何与圆角
    enum Layout {
        static let horizontalPadding: CGFloat = 18
        static let cardRadius: CGFloat = 20
        static let subCardRadius: CGFloat = 14
        static let floatingButtonSize: CGFloat = 46
        static let bottomPillHeight: CGFloat = 46
        /// 左侧无边界侧边栏占比（70% 屏宽，参考设计图）
        static let sidebarWidthRatio: CGFloat = 0.70
        /// 顶部渐进模糊消失区高度
        static let topProgressiveBlurHeight: CGFloat = 94
        static let glassBorderWidth: CGFloat = 0.5
        static let cardSpacing: CGFloat = 14
        static let bottomSafeClearance: CGFloat = 24
        static let menuBottomClearance: CGFloat = 96
        static let topSafeClearance: CGFloat = 52
    }

    // MARK: 景深模糊与缩放动效常量
    enum Motion {
        /// 底层主视图退场高斯模糊半径（0 → 45）
        static let mainBlurRadius: CGFloat = 45
        /// 底层主视图退场向后缩放（1.0 → 0.96）
        static let mainRecedeScale: CGFloat = 0.96
        /// 底层主视图暗化遮罩透明度（0 → 0.55）
        static let mainDimOpacity: CGFloat = 0.55

        /// 前景菜单浮层入场初始模糊半径（16 → 0）
        static let menuEntryBlurRadius: CGFloat = 16
        /// 前景菜单浮层入场初始缩放（0.95 → 1.0）
        static let menuEntryScale: CGFloat = 0.95

        /// 底部悬浮栏液态交叉淡化模糊半径（0 ↔ 12）
        static let dockCrossfadeBlurRadius: CGFloat = 12

        /// 所有悬浮毛玻璃按钮按压缩放（0.92）
        static let buttonPressScale: CGFloat = 0.92

        /// 全局统一原生阻尼弹簧曲线（完全可逆）
        static let transitionSpring: Animation = .spring(
            response: 0.38,
            dampingFraction: 0.86,
            blendDuration: 0
        )

        /// 按钮按压微回弹
        static let pressSpring: Animation = .spring(
            response: 0.24,
            dampingFraction: 0.72,
            blendDuration: 0
        )
    }

    // MARK: 触觉反馈
    @MainActor
    static func lightImpact() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.prepare()
        generator.impactOccurred()
    }

    @MainActor
    static func selectionTick() {
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }
}

// MARK: - 液态玻璃材质修饰器（iOS 26+ 原生 Liquid Glass .glassEffect，低版本平滑回退至 ultraThinMaterial）

struct LiquidGlassModifier<S: InsettableShape>: ViewModifier {
    let shape: S
    var highlightTint: Color? = nil
    var interactive: Bool = true

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(resolvedGlass, in: shape)
        } else {
            content
                .background {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay(shape.fill(highlightTint ?? DesignTokens.Colors.glassTint))
                }
                .overlay {
                    shape
                        .strokeBorder(
                            DesignTokens.Colors.glassBorder,
                            lineWidth: DesignTokens.Layout.glassBorderWidth
                        )
                }
                .shadow(color: DesignTokens.Colors.ambientShadow, radius: 14, x: 0, y: 6)
        }
    }

    @available(iOS 26.0, *)
    private var resolvedGlass: Glass {
        var glass: Glass = .regular
        if let highlightTint {
            glass = glass.tint(highlightTint)
        }
        if interactive {
            glass = glass.interactive()
        }
        return glass
    }
}

extension View {
    func liquidGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = true) -> some View {
        modifier(LiquidGlassModifier(shape: shape, highlightTint: tint, interactive: interactive))
    }
}

// MARK: - 渐进高斯模糊边缘消失层（复刻参考图上下边缘渐进模糊淡出效果）

struct ProgressiveEdgeBlurView: View {
    enum EdgePosition { case top, bottom }
    let edge: EdgePosition
    let height: CGFloat

    private var startPoint: UnitPoint { edge == .top ? .bottom : .top }
    private var endPoint: UnitPoint { edge == .top ? .top : .bottom }

    var body: some View {
        ZStack {
            // 第一层：宽范围轻柔模糊（内容刚开始进入边缘即轻微虚化）
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0.0),
                            .init(color: .black.opacity(0.45), location: 0.35),
                            .init(color: .black.opacity(0.92), location: 0.72),
                            .init(color: .black, location: 1.0)
                        ],
                        startPoint: startPoint,
                        endPoint: endPoint
                    )
                )

            // 第二层：中重度光学模糊（越靠近屏幕边缘与 Dock/顶栏越朦胧）
            Rectangle()
                .fill(.regularMaterial)
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0.0),
                            .init(color: .clear, location: 0.28),
                            .init(color: .black.opacity(0.65), location: 0.65),
                            .init(color: .black, location: 1.0)
                        ],
                        startPoint: startPoint,
                        endPoint: endPoint
                    )
                )

            // 第三层：画布底色平滑融出（在按钮与 Dock 区域彻底消融，保证图标绝对清晰）
            LinearGradient(
                stops: [
                    .init(color: DesignTokens.Colors.canvas.opacity(0.0), location: 0.0),
                    .init(color: DesignTokens.Colors.canvas.opacity(0.28), location: 0.36),
                    .init(color: DesignTokens.Colors.canvas.opacity(0.84), location: 0.70),
                    .init(color: DesignTokens.Colors.canvas, location: 0.94),
                    .init(color: DesignTokens.Colors.canvas, location: 1.0)
                ],
                startPoint: startPoint,
                endPoint: endPoint
            )
        }
        .frame(height: height)
        .allowsHitTesting(false)
    }
}

// MARK: - 侧边栏烟熏磨砂羽化遮罩（深浅双模式均保持一致的左侧 72% 磨砂透视 → 右侧柔和羽化过渡）

struct HorizontalSidebarVeilView: View {
    let isDark: Bool

    var body: some View {
        ZStack {
            if isDark {
                // 深色模式：左侧 72% 烟熏毛玻璃灰雾，向右侧平滑羽化融进纯黑
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .overlay(Color.white.opacity(0.055))
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .black, location: 0.0),
                                .init(color: .black.opacity(0.95), location: 0.62),
                                .init(color: .black.opacity(0.45), location: 0.75),
                                .init(color: .clear, location: 0.86)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )

                LinearGradient(
                    stops: [
                        .init(color: Color.black.opacity(0.34), location: 0.0),
                        .init(color: Color.black.opacity(0.30), location: 0.58),
                        .init(color: Color.black.opacity(0.58), location: 0.72),
                        .init(color: Color.black.opacity(0.94), location: 0.84),
                        .init(color: Color.black, location: 0.92),
                        .init(color: Color.black, location: 1.0)
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            } else {
                // 浅色模式：镜像深色透视逻辑——左侧 72% 柔和冷灰磨砂光雾透出底层模糊字影，向右侧平滑羽化沉入深雾纸面
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .overlay(Color.white.opacity(0.52))
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .black, location: 0.0),
                                .init(color: .black.opacity(0.95), location: 0.62),
                                .init(color: .black.opacity(0.45), location: 0.76),
                                .init(color: .clear, location: 0.88)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )

                LinearGradient(
                    stops: [
                        .init(color: Color(red: 0.95, green: 0.96, blue: 0.95).opacity(0.30), location: 0.0),
                        .init(color: Color(red: 0.92, green: 0.94, blue: 0.92).opacity(0.28), location: 0.58),
                        .init(color: Color(red: 0.76, green: 0.80, blue: 0.78).opacity(0.52), location: 0.74),
                        .init(color: Color(red: 0.64, green: 0.69, blue: 0.67).opacity(0.76), location: 0.86),
                        .init(color: Color(red: 0.58, green: 0.63, blue: 0.61).opacity(0.84), location: 1.0)
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - 悬浮按钮按压缩放回弹 + 轻触觉反馈

struct LiquidGlassPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? DesignTokens.Motion.buttonPressScale : 1.0)
            .animation(DesignTokens.Motion.pressSpring, value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                if pressed {
                    DesignTokens.lightImpact()
                }
            }
    }
}
