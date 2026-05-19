import XCTest
@testable import SloppyVoice

final class JSONValueTests: XCTestCase {
  func testDecodesAndEncodesObjects() throws {
    let data = Data(#"{"text":"hello","count":2,"ready":true,"items":["a",null]}"#.utf8)
    let value = try JSONDecoder().decode(JSONValue.self, from: data)

    XCTAssertEqual(value.objectValue?.string("text"), "hello")
    XCTAssertEqual(value.objectValue?.int("count"), 2)
    XCTAssertEqual(value.objectValue?.bool("ready"), true)
    XCTAssertEqual(value.objectValue?["items"]?.arrayValue?.first?.stringValue, "a")

    let encoded = try JSONEncoder().encode(value)
    let decodedAgain = try JSONDecoder().decode(JSONValue.self, from: encoded)
    XCTAssertEqual(decodedAgain, value)
  }
}

@MainActor
final class AppSettingsTests: XCTestCase {
  func testSttOnlyComposerModeDisablesAutoSpeakAndPersists() {
    let suite = "SloppyVoiceTests-\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: suite) else {
      XCTFail("Could not create isolated user defaults suite.")
      return
    }
    defer {
      defaults.removePersistentDomain(forName: suite)
    }

    let settings = AppSettings(defaults: defaults)
    XCTAssertTrue(settings.autoSpeak)

    settings.sttOnlyComposerMode = true
    XCTAssertFalse(settings.autoSpeak)

    let reloaded = AppSettings(defaults: defaults)
    XCTAssertTrue(reloaded.sttOnlyComposerMode)
    XCTAssertFalse(reloaded.autoSpeak)
  }
}
