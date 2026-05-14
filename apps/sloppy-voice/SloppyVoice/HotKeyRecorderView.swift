import AppKit
import SwiftUI

struct HotKeyRecorderView: NSViewRepresentable {
  @Binding var hotKey: HotKey

  func makeNSView(context: Context) -> RecorderView {
    let view = RecorderView()
    view.onHotKey = { hotKey = $0 }
    return view
  }

  func updateNSView(_ nsView: RecorderView, context: Context) {
    nsView.label = hotKey.displayName
  }

  final class RecorderView: NSView {
    var onHotKey: ((HotKey) -> Void)?
    var label = "" {
      didSet {
        needsDisplay = true
      }
    }

    override var acceptsFirstResponder: Bool {
      true
    }

    override func mouseDown(with event: NSEvent) {
      window?.makeFirstResponder(self)
      needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
      if let hotKey = HotKey.from(event: event) {
        onHotKey?(hotKey)
      }
    }

    override func draw(_ dirtyRect: NSRect) {
      NSColor.controlBackgroundColor.setFill()
      bounds.fill()
      let focused = window?.firstResponder === self
      let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
      (focused ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
      border.lineWidth = 1
      border.stroke()

      let text = focused ? "Press keys..." : label
      let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 12),
        .foregroundColor: NSColor.labelColor,
      ]
      let size = text.size(withAttributes: attributes)
      let rect = NSRect(
        x: bounds.midX - size.width / 2,
        y: bounds.midY - size.height / 2,
        width: size.width,
        height: size.height
      )
      text.draw(in: rect, withAttributes: attributes)
    }
  }
}
