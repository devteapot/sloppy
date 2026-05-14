import XCTest
@testable import SloppyVoice

final class VoiceTurnTrackerTests: XCTestCase {
  func testStartedTurnSpeaksMatchingAssistantOnce() {
    var tracker = VoiceTurnTracker()
    tracker.recordSubmitted(
      text: "hello",
      outcome: SendMessageOutcome(status: "started", turnId: "turn-1", queuedMessageId: nil, position: nil)
    )

    let transcript = [
      TranscriptMessage(id: "u1", role: "user", state: "complete", turnId: "turn-1", text: "hello"),
      TranscriptMessage(id: "a1", role: "assistant", state: "complete", turnId: "turn-1", text: "hi"),
    ]

    XCTAssertEqual(
      tracker.nextSpeechRequest(from: transcript),
      AssistantSpeechRequest(messageId: "a1", turnId: "turn-1", text: "hi")
    )
    XCTAssertNil(tracker.nextSpeechRequest(from: transcript))
  }

  func testQueuedTurnMapsByUserTranscript() {
    var tracker = VoiceTurnTracker()
    tracker.recordSubmitted(
      text: "queued text",
      outcome: SendMessageOutcome(status: "queued", turnId: nil, queuedMessageId: "q1", position: 1)
    )
    let transcript = [
      TranscriptMessage(id: "u1", role: "user", state: "complete", turnId: "turn-2", text: "queued text"),
      TranscriptMessage(id: "a1", role: "assistant", state: "complete", turnId: "turn-2", text: "done"),
    ]
    tracker.observe(transcript: transcript)
    XCTAssertEqual(tracker.nextSpeechRequest(from: transcript)?.messageId, "a1")
  }
}
