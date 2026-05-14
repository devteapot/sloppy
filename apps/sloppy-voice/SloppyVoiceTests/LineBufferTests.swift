import XCTest
@testable import SloppyVoice

final class LineBufferTests: XCTestCase {
  func testSplitsNdjsonAcrossChunks() {
    var buffer = LineBuffer()
    XCTAssertEqual(buffer.append(Data(#"{"type":"hello"}"#.utf8)), [])
    XCTAssertEqual(buffer.append(Data("\n{\"type\":\"patch\"}\n".utf8)), [
      #"{"type":"hello"}"#,
      #"{"type":"patch"}"#,
    ])
  }
}
