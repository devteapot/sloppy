import XCTest
@testable import SloppyVoice

final class ProviderDiscoveryTests: XCTestCase {
  func testPrefersSupervisorDescriptor() throws {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("sloppy-voice-provider-discovery-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    try Data(#"{"id":"sloppy-session-a","name":"Session","transport":{"type":"unix","path":"/tmp/session.sock"}}"#.utf8)
      .write(to: directory.appendingPathComponent("session.json"))
    try Data(#"{"id":"sloppy-session-supervisor","name":"Supervisor","transport":{"type":"unix","path":"/tmp/supervisor.sock"}}"#.utf8)
      .write(to: directory.appendingPathComponent("supervisor.json"))

    let preferred = ProviderDiscovery.preferredCandidate(in: directory)
    XCTAssertEqual(preferred?.id, "sloppy-session-supervisor")
    XCTAssertEqual(preferred?.socketPath, "/tmp/supervisor.sock")
    XCTAssertEqual(preferred?.kind, .supervisor)
  }
}
