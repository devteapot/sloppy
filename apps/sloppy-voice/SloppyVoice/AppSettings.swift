import Foundation

@MainActor
final class AppSettings: ObservableObject {
  @Published var socketPath: String {
    didSet { defaults.set(socketPath, forKey: Keys.socketPath) }
  }
  @Published var autoSpeak: Bool {
    didSet { defaults.set(autoSpeak, forKey: Keys.autoSpeak) }
  }
  @Published var sttOnlyComposerMode: Bool {
    didSet {
      defaults.set(sttOnlyComposerMode, forKey: Keys.sttOnlyComposerMode)
      if sttOnlyComposerMode && autoSpeak {
        autoSpeak = false
      }
    }
  }
  @Published var hotKey: HotKey {
    didSet {
      if let data = try? JSONEncoder().encode(hotKey) {
        defaults.set(data, forKey: Keys.hotKey)
      }
    }
  }
  @Published var preferredInputAdapter: String {
    didSet { defaults.set(preferredInputAdapter, forKey: Keys.preferredInputAdapter) }
  }
  @Published var preferredInputModel: String {
    didSet { defaults.set(preferredInputModel, forKey: Keys.preferredInputModel) }
  }
  @Published var preferredInputLanguage: String {
    didSet { defaults.set(preferredInputLanguage, forKey: Keys.preferredInputLanguage) }
  }
  @Published var preferredOutputAdapter: String {
    didSet { defaults.set(preferredOutputAdapter, forKey: Keys.preferredOutputAdapter) }
  }
  @Published var preferredOutputModel: String {
    didSet { defaults.set(preferredOutputModel, forKey: Keys.preferredOutputModel) }
  }
  @Published var preferredOutputVoice: String {
    didSet { defaults.set(preferredOutputVoice, forKey: Keys.preferredOutputVoice) }
  }
  @Published var preferredOutputFormat: String {
    didSet { defaults.set(preferredOutputFormat, forKey: Keys.preferredOutputFormat) }
  }

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    socketPath = defaults.string(forKey: Keys.socketPath) ?? ""
    autoSpeak = defaults.object(forKey: Keys.autoSpeak) as? Bool ?? true
    sttOnlyComposerMode = defaults.object(forKey: Keys.sttOnlyComposerMode) as? Bool ?? false
    if
      let data = defaults.data(forKey: Keys.hotKey),
      let decoded = try? JSONDecoder().decode(HotKey.self, from: data)
    {
      hotKey = decoded
    } else {
      hotKey = .defaultPushToTalk
    }
    preferredInputAdapter = defaults.string(forKey: Keys.preferredInputAdapter) ?? ""
    preferredInputModel = defaults.string(forKey: Keys.preferredInputModel) ?? ""
    preferredInputLanguage = defaults.string(forKey: Keys.preferredInputLanguage) ?? "auto"
    preferredOutputAdapter = defaults.string(forKey: Keys.preferredOutputAdapter) ?? ""
    preferredOutputModel = defaults.string(forKey: Keys.preferredOutputModel) ?? ""
    preferredOutputVoice = defaults.string(forKey: Keys.preferredOutputVoice) ?? ""
    preferredOutputFormat = defaults.string(forKey: Keys.preferredOutputFormat) ?? "wav"

    if sttOnlyComposerMode && autoSpeak {
      autoSpeak = false
      defaults.set(false, forKey: Keys.autoSpeak)
    }
  }

  private enum Keys {
    static let socketPath = "socketPath"
    static let autoSpeak = "autoSpeak"
    static let sttOnlyComposerMode = "sttOnlyComposerMode"
    static let hotKey = "hotKey"
    static let preferredInputAdapter = "preferredInputAdapter"
    static let preferredInputModel = "preferredInputModel"
    static let preferredInputLanguage = "preferredInputLanguage"
    static let preferredOutputAdapter = "preferredOutputAdapter"
    static let preferredOutputModel = "preferredOutputModel"
    static let preferredOutputVoice = "preferredOutputVoice"
    static let preferredOutputFormat = "preferredOutputFormat"
  }
}
