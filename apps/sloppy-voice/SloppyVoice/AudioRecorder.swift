import AVFoundation
import Foundation

enum AudioRecorderError: LocalizedError {
  case permissionDenied
  case missingInput
  case cannotCreateFormat
  case cannotStart

  var errorDescription: String? {
    switch self {
    case .permissionDenied:
      return "Microphone permission is denied."
    case .missingInput:
      return "No microphone input device is available."
    case .cannotCreateFormat:
      return "Could not create the recording audio format."
    case .cannotStart:
      return "Could not start microphone recording."
    }
  }
}

@MainActor
final class AudioRecorder: ObservableObject {
  @Published private(set) var isRecording = false
  @Published private(set) var level: Double = 0
  @Published private(set) var elapsed: TimeInterval = 0

  private var audioRecorder: AVAudioRecorder?
  private var outputURL: URL?
  private var timer: Timer?

  func requestPermissionIfNeeded() async throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      return
    case .notDetermined:
      let granted = await AVCaptureDevice.requestAccess(for: .audio)
      if !granted {
        throw AudioRecorderError.permissionDenied
      }
    default:
      throw AudioRecorderError.permissionDenied
    }
  }

  func start() async throws {
    try await requestPermissionIfNeeded()
    _ = stop()

    guard AVCaptureDevice.default(for: .audio) != nil else {
      throw AudioRecorderError.missingInput
    }

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("sloppy-voice-\(UUID().uuidString)")
      .appendingPathExtension("wav")

    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16_000.0,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsNonInterleaved: false,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]
    guard let format = AVAudioFormat(settings: settings), format.channelCount > 0 else {
      throw AudioRecorderError.cannotCreateFormat
    }

    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.isMeteringEnabled = true
    recorder.prepareToRecord()
    guard recorder.record() else {
      throw AudioRecorderError.cannotStart
    }

    audioRecorder = recorder
    outputURL = url
    isRecording = true
    startTimer()
  }

  func stop() -> URL? {
    timer?.invalidate()
    timer = nil

    audioRecorder?.stop()
    audioRecorder = nil
    isRecording = false
    level = 0
    elapsed = 0

    let url = outputURL
    outputURL = nil
    return url
  }

  func discard(_ url: URL?) {
    guard let url else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }

  private func startTimer() {
    timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, let recorder = self.audioRecorder else {
          return
        }
        recorder.updateMeters()
        self.elapsed = recorder.currentTime
        self.level = Self.normalizedLevel(from: recorder.averagePower(forChannel: 0))
      }
    }
  }

  private static func normalizedLevel(from decibels: Float) -> Double {
    guard decibels.isFinite else {
      return 0
    }
    let clamped = max(-60, min(0, decibels))
    return pow(10, Double(clamped) / 20)
  }
}
