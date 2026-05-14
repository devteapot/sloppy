import SwiftUI

@main
struct SloppyVoiceApp: App {
  @StateObject private var model = VoiceAppModel()

  var body: some Scene {
    MenuBarExtra {
      VoiceMenuView(model: model)
    } label: {
      Image(systemName: model.recorder.isRecording ? "mic.fill" : "waveform.circle")
    }
    .menuBarExtraStyle(.window)
  }
}
