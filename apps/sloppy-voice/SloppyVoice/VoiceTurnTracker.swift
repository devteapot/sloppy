import Foundation

struct AssistantSpeechRequest: Equatable {
  let messageId: String
  let turnId: String
  let text: String
}

struct VoiceTurnTracker {
  private var pendingSubmittedTexts: [String] = []
  private var voiceTurnIds: Set<String> = []
  private var spokenMessageIds: Set<String> = []

  mutating func recordSubmitted(text: String, outcome: SendMessageOutcome) {
    if let turnId = outcome.turnId {
      voiceTurnIds.insert(turnId)
    } else {
      pendingSubmittedTexts.append(text)
    }
  }

  mutating func observe(transcript: [TranscriptMessage]) {
    guard !pendingSubmittedTexts.isEmpty else {
      return
    }

    for message in transcript where message.role == "user" {
      guard let turnId = message.turnId else {
        continue
      }
      if let index = pendingSubmittedTexts.firstIndex(of: message.text) {
        voiceTurnIds.insert(turnId)
        pendingSubmittedTexts.remove(at: index)
      }
    }
  }

  mutating func nextSpeechRequest(from transcript: [TranscriptMessage]) -> AssistantSpeechRequest? {
    for message in transcript where message.role == "assistant" && message.state == "complete" {
      guard
        let turnId = message.turnId,
        voiceTurnIds.contains(turnId),
        !spokenMessageIds.contains(message.id),
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else {
        continue
      }
      spokenMessageIds.insert(message.id)
      return AssistantSpeechRequest(messageId: message.id, turnId: turnId, text: message.text)
    }
    return nil
  }
}
