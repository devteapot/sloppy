import Foundation

enum VoiceConnectionStatus: Equatable {
  case disconnected
  case connecting
  case connected(String)
  case error(String)

  var label: String {
    switch self {
    case .disconnected:
      return "Disconnected"
    case .connecting:
      return "Connecting"
    case .connected(let socket):
      return "Connected: \(socket)"
    case .error(let message):
      return "Error: \(message)"
    }
  }
}

@MainActor
final class VoiceAppModel: ObservableObject {
  @Published var connectionStatus: VoiceConnectionStatus = .disconnected
  @Published var voiceProviderConnected = false
  @Published var composerReady = false
  @Published var composerDisabledReason: String?
  @Published var turnState = "idle"
  @Published var queuedCount = 0
  @Published var transcript: [TranscriptMessage] = []
  @Published var inputState = VoiceInputState()
  @Published var outputState = VoiceOutputState()
  @Published var lastUserTranscript = ""
  @Published var lastError: String?
  @Published var isTranscribing = false
  @Published var hotKeyWarning: String?
  @Published private var isStartingRecording = false

  var settings = AppSettings()
  let recorder = AudioRecorder()
  let player = AudioPlayerService()

  private let hotKeyManager = HotKeyManager()
  private var session: SloppySessionClient?
  private var tracker = VoiceTurnTracker()
  private var refreshTask: Task<Void, Never>?
  private var didStart = false

  var canRecord: Bool {
    voiceProviderConnected && composerReady && !recorder.isRecording && !isTranscribing && !isStartingRecording
  }

  func start() async {
    guard !didStart else {
      return
    }
    didStart = true
    registerHotKey()
    await connect()
  }

  func connect() async {
    connectionStatus = .connecting
    lastError = nil
    do {
      let socketPath = try await resolveSessionSocket()
      let client = SloppySessionClient(socketPath: socketPath)
      try await client.connect()
      session?.disconnect()
      session = client
      settings.socketPath = socketPath
      connectionStatus = .connected(socketPath)
      try await subscribe(client)
      await refresh()
      await reapplySavedVoiceSettings()
    } catch {
      connectionStatus = .error(error.localizedDescription)
      lastError = error.localizedDescription
    }
  }

  func disconnect() {
    session?.disconnect()
    session = nil
    connectionStatus = .disconnected
    voiceProviderConnected = false
  }

  func registerHotKey() {
    do {
      try hotKeyManager.register(settings.hotKey) { [weak self] in
        Task { @MainActor in
          await self?.beginPushToTalk()
        }
      } onReleased: { [weak self] in
        Task { @MainActor in
          await self?.endPushToTalk()
        }
      }
      hotKeyWarning = nil
    } catch {
      hotKeyWarning = error.localizedDescription
    }
  }

  func beginPushToTalk() async {
    guard canRecord else {
      return
    }
    isStartingRecording = true
    defer {
      isStartingRecording = false
    }
    player.stop()
    _ = try? await session?.invokeVoice("/output", action: "cancel")
    do {
      try await recorder.start()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func endPushToTalk() async {
    guard recorder.isRecording else {
      return
    }
    let url = recorder.stop()
    guard let url else {
      return
    }
    isTranscribing = true
    defer {
      recorder.discard(url)
      isTranscribing = false
    }

    do {
      let text = try await transcribe(url: url)
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else {
        lastError = "No speech detected."
        return
      }
      lastUserTranscript = trimmed
      guard let session else {
        throw SlopClientError.notConnected
      }
      let outcome = try await session.sendMessage(trimmed)
      tracker.recordSubmitted(text: trimmed, outcome: outcome)
      await refresh()
    } catch {
      lastError = error.localizedDescription
    }
  }

  func stopPlayback() async {
    player.stop()
    _ = try? await session?.invokeVoice("/output", action: "cancel")
  }

  func applyVoiceSettings() async {
    guard let session, voiceProviderConnected else {
      return
    }

    do {
      if !settings.preferredInputAdapter.isEmpty {
        var params: [String: JSONValue] = [
          "adapter_id": .string(settings.preferredInputAdapter),
        ]
        if !settings.preferredInputModel.isEmpty {
          params["model"] = .string(settings.preferredInputModel)
        }
        if !settings.preferredInputLanguage.isEmpty {
          params["language"] = .string(settings.preferredInputLanguage)
        }
        _ = try await session.invokeVoice("/input", action: "set_adapter", params: params)
      }

      if !settings.preferredOutputAdapter.isEmpty {
        var params: [String: JSONValue] = [
          "adapter_id": .string(settings.preferredOutputAdapter),
        ]
        if !settings.preferredOutputModel.isEmpty {
          params["model"] = .string(settings.preferredOutputModel)
        }
        if !settings.preferredOutputFormat.isEmpty {
          params["format"] = .string(settings.preferredOutputFormat)
        }
        _ = try await session.invokeVoice("/output", action: "set_adapter", params: params)
      }

      if !settings.preferredOutputVoice.isEmpty {
        _ = try await session.invokeVoice(
          "/output",
          action: "set_voice",
          params: ["voice": .string(settings.preferredOutputVoice)]
        )
      }

      await refresh()
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func resolveSessionSocket() async throws -> String {
    if !settings.socketPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return settings.socketPath
    }

    guard let candidate = ProviderDiscovery.preferredCandidate() else {
      throw SlopClientError.connectionFailed(
        "No Sloppy session found. Start a supervisor with bun run session:serve -- --supervisor --socket /tmp/slop/sloppy-supervisor.sock."
      )
    }

    switch candidate.kind {
    case .session:
      return candidate.socketPath
    case .supervisor:
      let supervisor = SlopClient()
      _ = try await supervisor.connect(socketPath: candidate.socketPath)
      defer { supervisor.disconnect() }
      let sessionNode = try await supervisor.query(path: "/session", depth: 1)
      guard let socket = sessionNode.propertyString("active_socket_path"), !socket.isEmpty else {
        throw SlopClientError.connectionFailed("Supervisor did not expose an active session socket.")
      }
      return socket
    }
  }

  private func subscribe(_ client: SloppySessionClient) async throws {
    let invalidate: () -> Void = { [weak self] in
      Task { @MainActor in
        self?.queueRefresh()
      }
    }
    try await client.subscribe("/apps", depth: 2, onInvalidate: invalidate)
    try await client.subscribe("/composer", depth: 1, onInvalidate: invalidate)
    try await client.subscribe("/turn", depth: 1, onInvalidate: invalidate)
    try await client.subscribe("/transcript", depth: 3, onInvalidate: invalidate)
  }

  private func queueRefresh() {
    refreshTask?.cancel()
    refreshTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 150_000_000)
      guard !Task.isCancelled else {
        return
      }
      await refresh()
    }
  }

  private func refresh() async {
    guard let session else {
      return
    }

    do {
      let apps = try await session.query("/apps", depth: 2)
      voiceProviderConnected = await isVoiceProviderReachable(session: session, apps: apps)

      let composer = try await session.query("/composer", depth: 1)
      composerReady = composer.propertyBool("ready") ?? false
      composerDisabledReason = composer.propertyString("disabled_reason")
      queuedCount = composer.propertyInt("queued_count") ?? 0

      let turn = try await session.query("/turn", depth: 1)
      turnState = turn.propertyString("state") ?? "unknown"

      let transcriptNode = try await session.query("/transcript", depth: 3)
      transcript = transcriptNode.children?.compactMap(TranscriptMessage.parse) ?? []
      tracker.observe(transcript: transcript)

      if voiceProviderConnected {
        inputState = VoiceInputState.parse(try await session.queryVoice("/input", depth: 1))
        outputState = VoiceOutputState.parse(try await session.queryVoice("/output", depth: 1))
      }

      await speakNextAssistantIfNeeded()
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func isVoiceProviderReachable(session: SloppySessionClient, apps: SlopNode) async -> Bool {
    if apps.children?.contains(where: { node in
      node.propertyString("provider_id") == "voice" && node.propertyString("status") == "connected"
    }) == true {
      return true
    }

    do {
      let node = try await session.queryVoice("/session", depth: 1)
      return node.propertyString("status") == "ready"
    } catch {
      return false
    }
  }

  private func transcribe(url: URL) async throws -> String {
    guard let session else {
      throw SlopClientError.notConnected
    }

    let opened = try await session.invokeVoice(
      "/input",
      action: "open_stream",
      params: ["mime": .string("audio/wav")]
    )
    guard
      let data = opened.data?.objectValue,
      let uploadURLText = data.string("upload_url"),
      let uploadURL = URL(string: uploadURLText),
      let token = data.string("token")
    else {
      throw SlopClientError.invalidResponse("open_stream did not return upload details")
    }

    var request = URLRequest(url: uploadURL)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")

    let (responseData, response) = try await URLSession.shared.upload(for: request, fromFile: url)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let message = String(data: responseData, encoding: .utf8) ?? "Voice upload failed."
      throw SlopClientError.providerError(message)
    }
    let value = try JSONDecoder().decode(JSONValue.self, from: responseData)
    guard let text = value.objectValue?.string("text") else {
      throw SlopClientError.invalidResponse("voice upload did not return text")
    }
    return text
  }

  private func speakNextAssistantIfNeeded() async {
    guard settings.autoSpeak, !player.isPlaying else {
      return
    }
    guard let request = tracker.nextSpeechRequest(from: transcript) else {
      return
    }

    do {
      guard let session else {
        throw SlopClientError.notConnected
      }
      let synthesized = try await session.invokeVoice(
        "/output",
        action: "synthesize",
        params: [
          "text": .string(request.text),
          "message_id": .string(request.messageId),
        ]
      )
      guard
        let segmentId = synthesized.data?.objectValue?.string("segment_id")
      else {
        throw SlopClientError.invalidResponse("synthesize did not return a segment id")
      }
      let content = try await session.invokeVoice("/output/segments/\(segmentId)", action: "read_content")
      guard
        let object = content.data?.objectValue,
        object.string("encoding") == "base64",
        let base64 = object.string("content"),
        let audioData = Data(base64Encoded: base64)
      else {
        throw SlopClientError.invalidResponse("read_content did not return base64 audio")
      }
      try player.play(data: audioData)
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func reapplySavedVoiceSettings() async {
    guard voiceProviderConnected else {
      return
    }
    if
      !settings.preferredInputAdapter.isEmpty ||
        !settings.preferredOutputAdapter.isEmpty ||
        !settings.preferredOutputVoice.isEmpty
    {
      await applyVoiceSettings()
    }
  }
}
