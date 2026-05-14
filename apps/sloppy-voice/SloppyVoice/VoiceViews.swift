import SwiftUI

struct VoiceMenuView: View {
  @ObservedObject var model: VoiceAppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      Divider()
      recordingControl
      statusGrid
      transcriptPreview
      settings
      footer
    }
    .padding(14)
    .frame(width: 380)
    .task {
      await model.start()
    }
  }

  private var header: some View {
    HStack {
      Label("Sloppy Voice", systemImage: "waveform.circle.fill")
        .font(.headline)
      Spacer()
      Button {
        Task { await model.connect() }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .help("Reconnect")
      Button {
        NSApplication.shared.terminate(nil)
      } label: {
        Image(systemName: "xmark.circle")
      }
      .help("Quit")
    }
  }

  private var recordingControl: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
      } label: {
        HStack {
          Image(systemName: model.recorder.isRecording ? "mic.fill" : "mic")
          Text(model.recorder.isRecording ? "Recording..." : "Hold to Talk")
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .disabled(!model.canRecord && !model.recorder.isRecording)
      .simultaneousGesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in
            Task { await model.beginPushToTalk() }
          }
          .onEnded { _ in
            Task { await model.endPushToTalk() }
          }
      )

      ProgressView(value: model.recorder.level)
      HStack {
        Text(model.settings.hotKey.displayName)
        Spacer()
        Text(model.recorder.isRecording ? String(format: "%.1fs", model.recorder.elapsed) : "Ready")
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  private var statusGrid: some View {
    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 5) {
      row("Session", model.connectionStatus.label)
      row("Voice", model.voiceProviderConnected ? "Connected" : "Missing")
      row("Composer", model.composerReady ? "Ready" : (model.composerDisabledReason ?? "Not ready"))
      row("Turn", model.turnState)
      row("Queue", "\(model.queuedCount)")
      row("STT", "\(model.inputState.activeAdapterId) \(model.inputState.activeModel)")
      row("TTS", "\(model.outputState.activeAdapterId) \(model.outputState.activeModel) \(model.outputState.voice)")
    }
    .font(.caption)
  }

  private func row(_ key: String, _ value: String) -> some View {
    GridRow {
      Text(key)
        .foregroundStyle(.secondary)
      Text(value.isEmpty ? "-" : value)
        .lineLimit(2)
    }
  }

  private var transcriptPreview: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("Last Transcript")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(model.lastUserTranscript.isEmpty ? "No voice turn yet." : model.lastUserTranscript)
        .font(.body)
        .lineLimit(4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var settings: some View {
    DisclosureGroup("Settings") {
      VStack(alignment: .leading, spacing: 8) {
        TextField("Session socket", text: $model.settings.socketPath)
        Toggle("Auto-speak voice replies", isOn: $model.settings.autoSpeak)
        HStack {
          Text("Hotkey")
          HotKeyRecorderView(hotKey: $model.settings.hotKey)
            .frame(width: 150, height: 28)
          Button("Apply") {
            model.registerHotKey()
          }
        }
        if let warning = model.hotKeyWarning {
          Text(warning)
            .foregroundStyle(.orange)
            .font(.caption)
        }

        Divider()

        Picker("STT Adapter", selection: $model.settings.preferredInputAdapter) {
          Text("Runtime default").tag("")
          ForEach(model.inputState.availableAdapters, id: \.self) { adapter in
            Text(adapter).tag(adapter)
          }
        }
        TextField("STT model", text: $model.settings.preferredInputModel)
        TextField("Language", text: $model.settings.preferredInputLanguage)

        Picker("TTS Adapter", selection: $model.settings.preferredOutputAdapter) {
          Text("Runtime default").tag("")
          ForEach(model.outputState.availableAdapters, id: \.self) { adapter in
            Text(adapter).tag(adapter)
          }
        }
        TextField("TTS model", text: $model.settings.preferredOutputModel)
        TextField("Voice", text: $model.settings.preferredOutputVoice)
        TextField("Format", text: $model.settings.preferredOutputFormat)
        Button("Apply Voice Settings") {
          Task { await model.applyVoiceSettings() }
        }
      }
      .textFieldStyle(.roundedBorder)
      .padding(.top, 6)
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.player.isPlaying {
        Button {
          Task { await model.stopPlayback() }
        } label: {
          Label("Stop Speaking", systemImage: "speaker.slash.fill")
        }
      }
      if let error = model.lastError {
        Text(error)
          .foregroundStyle(.red)
          .font(.caption)
          .lineLimit(3)
      }
    }
  }
}
