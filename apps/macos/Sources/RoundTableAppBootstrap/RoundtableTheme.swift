import AppKit
import SwiftUI

// Design tokens from src/ui/styles/tokens.css (`neutral` aesthetic, light
// theme) and the Web's default `soft` agent palette. The Web mixes colours in
// oklab; `mix` here interpolates in sRGB, which is close enough at the small
// percentages the stage uses.
enum RT {
    // `neutral` light / dark tokens. Colours resolve against the view's appearance,
    // so the whole UI follows the system light/dark setting as the Web's theme does.
    static let bg = dynamic(light: 0xEEEAF6, dark: 0x14121C)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x1C1926)
    static let surface2 = dynamic(light: 0xF5F2FB, dark: 0x232030)
    static let surface3 = dynamic(light: 0xEBE6F4, dark: 0x2B2740)
    static let border = dynamic(light: 0xE2DBEF, dark: 0x2C2940)
    static let borderStrong = dynamic(light: 0xCFC5E2, dark: 0x3D3A55)
    static let text = dynamic(light: 0x36304F, dark: 0xECE8F6)
    static let textMuted = dynamic(light: 0x6E6588, dark: 0xA39DB8)
    static let textFaint = dynamic(light: 0x9C95B4, dark: 0x6A6680)
    static let pm = dynamic(light: 0x8076A0, dark: 0x908AA6)
    static let accent = dynamic(light: 0x7E72C9, dark: 0xA99AE0)
    static let ok = Color(hex: 0x5A9E8C)
    static let run = Color(hex: 0x5F86B8)
    static let warn = Color(hex: 0xBD9A55)

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(hex: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
        })
    }

    /// Agent identity colours after `palettize('soft')`.
    static func agentColor(_ agentId: String?) -> Color {
        switch agentId {
        case "orchestrator": Color(hex: 0x938B7C)
        case "mira": Color(hex: 0xB27858)
        case "atlas": Color(hex: 0x5F86B8)
        case "beam": Color(hex: 0x5A9E8C)
        case "vera": Color(hex: 0xBD9A55)
        case "nova": Color(hex: 0x9579B0)
        case "fixer": Color(hex: 0xC47766)
        default: pm
        }
    }

    /// `tint(color, pct)`: the colour mixed into the surface.
    static func tint(_ color: Color, _ percent: Double, base: Color = surface) -> Color {
        mix(color, percent / 100, into: base)
    }

    /// `alpha(color, pct)`: the colour at the given opacity.
    static func alpha(_ color: Color, _ percent: Double) -> Color {
        color.opacity(percent / 100)
    }

    /// Mixes in sRGB and resolves both colours against the current appearance,
    /// so tints stay correct when the system switches between light and dark.
    static func mix(_ color: Color, _ amount: Double, into base: Color) -> Color {
        let a = NSColor(color), b = NSColor(base)
        return Color(nsColor: NSColor(name: nil) { appearance in
            var result = NSColor.black
            appearance.performAsCurrentDrawingAppearance {
                let x = a.usingColorSpace(.sRGB) ?? .black
                let y = b.usingColorSpace(.sRGB) ?? .white
                func lerp(_ p: CGFloat, _ q: CGFloat) -> CGFloat { q + (p - q) * amount }
                result = NSColor(srgbRed: lerp(x.redComponent, y.redComponent), green: lerp(x.greenComponent, y.greenComponent),
                                 blue: lerp(x.blueComponent, y.blueComponent), alpha: lerp(x.alphaComponent, y.alphaComponent))
            }
            return result
        })
    }

    // IBM Plex, as on the Web (`--font-ui`, `--font-mono`). The faces ship in the
    // app bundle and are registered at launch; system fonts are the fallback.
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        fontsRegistered ? .custom("IBM Plex Sans", size: size).weight(weight) : .system(size: size, weight: weight)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        fontsRegistered ? .custom("IBM Plex Mono", size: size).weight(weight) : .system(size: size, weight: weight, design: .monospaced)
    }

    nonisolated(unsafe) private(set) static var fontsRegistered = false

    /// Registers the bundled IBM Plex faces for this process.
    static func registerFonts(bundle: Bundle = .main) {
        guard !fontsRegistered else { return }
        let urls = (bundle.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
            + (bundle.urls(forResourcesWithExtension: "ttf", subdirectory: "fonts") ?? [])
        let plex = urls.filter { $0.lastPathComponent.hasPrefix("IBMPlex") }
        guard !plex.isEmpty else { return }
        CTFontManagerRegisterFontURLs(plex as CFArray, .process, true, nil)
        fontsRegistered = true
    }

    /// SF Symbol for a Web `Icon` name used by workflow stages.
    static func symbol(forStageIcon icon: String?) -> String {
        switch icon {
        case "clip": "paperclip"
        case "search": "magnifyingglass"
        case "layers": "square.3.layers.3d"
        case "code": "chevron.left.forwardslash.chevron.right"
        case "eye": "eye"
        case "wrench": "wrench.adjustable"
        case "rocket": "paperplane"
        case "check": "checkmark"
        default: "circle"
        }
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}
