import AVFoundation
import Foundation

@MainActor
final class AudioPlayerService: NSObject, ObservableObject, AVAudioPlayerDelegate {
  @Published private(set) var isPlaying = false

  private var player: AVAudioPlayer?

  func play(data: Data) throws {
    stop()
    let player = try AVAudioPlayer(data: data)
    player.delegate = self
    player.prepareToPlay()
    self.player = player
    isPlaying = player.play()
  }

  func stop() {
    player?.stop()
    player = nil
    isPlaying = false
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      self.isPlaying = false
      self.player = nil
    }
  }
}
