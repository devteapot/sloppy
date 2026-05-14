import AppKit
import Carbon
import Foundation

struct HotKey: Codable, Equatable {
  var keyCode: UInt32
  var modifiers: UInt32

  static let defaultPushToTalk = HotKey(keyCode: 49, modifiers: UInt32(optionKey))

  var displayName: String {
    var parts: [String] = []
    if modifiers & UInt32(cmdKey) != 0 {
      parts.append("Command")
    }
    if modifiers & UInt32(optionKey) != 0 {
      parts.append("Option")
    }
    if modifiers & UInt32(controlKey) != 0 {
      parts.append("Control")
    }
    if modifiers & UInt32(shiftKey) != 0 {
      parts.append("Shift")
    }
    parts.append(Self.keyName(keyCode))
    return parts.joined(separator: "+")
  }

  static func from(event: NSEvent) -> HotKey? {
    let modifiers = carbonModifiers(from: event.modifierFlags)
    guard modifiers != 0 else {
      return nil
    }
    return HotKey(keyCode: UInt32(event.keyCode), modifiers: modifiers)
  }

  static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
    var value: UInt32 = 0
    if flags.contains(.command) {
      value |= UInt32(cmdKey)
    }
    if flags.contains(.option) {
      value |= UInt32(optionKey)
    }
    if flags.contains(.control) {
      value |= UInt32(controlKey)
    }
    if flags.contains(.shift) {
      value |= UInt32(shiftKey)
    }
    return value
  }

  private static func keyName(_ keyCode: UInt32) -> String {
    switch keyCode {
    case 36:
      return "Return"
    case 48:
      return "Tab"
    case 49:
      return "Space"
    case 51:
      return "Delete"
    case 53:
      return "Escape"
    case 123:
      return "Left"
    case 124:
      return "Right"
    case 125:
      return "Down"
    case 126:
      return "Up"
    default:
      return "Key \(keyCode)"
    }
  }
}

@MainActor
final class HotKeyManager {
  private var hotKeyRef: EventHotKeyRef?
  private var eventHandlerRef: EventHandlerRef?
  private var hotKeyId = EventHotKeyID(signature: 0x534C5656, id: 1)
  private var onPressed: (() -> Void)?
  private var onReleased: (() -> Void)?

  func register(_ hotKey: HotKey, onPressed: @escaping () -> Void, onReleased: @escaping () -> Void) throws {
    unregister()
    self.onPressed = onPressed
    self.onReleased = onReleased

    var eventTypes = [
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
    ]

    let handlerStatus = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, userData in
        guard let userData, let event else {
          return noErr
        }
        let manager = Unmanaged<HotKeyManager>.fromOpaque(userData).takeUnretainedValue()
        var hotKeyId = EventHotKeyID()
        let status = GetEventParameter(
          event,
          EventParamName(kEventParamDirectObject),
          EventParamType(typeEventHotKeyID),
          nil,
          MemoryLayout<EventHotKeyID>.size,
          nil,
          &hotKeyId
        )
        guard status == noErr, hotKeyId.id == manager.hotKeyId.id else {
          return noErr
        }

        let kind = GetEventKind(event)
        Task { @MainActor in
          if kind == UInt32(kEventHotKeyPressed) {
            manager.onPressed?()
          } else if kind == UInt32(kEventHotKeyReleased) {
            manager.onReleased?()
          }
        }
        return noErr
      },
      eventTypes.count,
      &eventTypes,
      Unmanaged.passUnretained(self).toOpaque(),
      &eventHandlerRef
    )
    guard handlerStatus == noErr else {
      throw SlopClientError.connectionFailed("Could not install hotkey handler (\(handlerStatus)).")
    }

    let registerStatus = RegisterEventHotKey(
      hotKey.keyCode,
      hotKey.modifiers,
      hotKeyId,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )
    guard registerStatus == noErr else {
      unregister()
      throw SlopClientError.connectionFailed("Could not register \(hotKey.displayName) (\(registerStatus)).")
    }
  }

  func unregister() {
    if let hotKeyRef {
      UnregisterEventHotKey(hotKeyRef)
    }
    hotKeyRef = nil
    if let eventHandlerRef {
      RemoveEventHandler(eventHandlerRef)
    }
    eventHandlerRef = nil
  }
}
