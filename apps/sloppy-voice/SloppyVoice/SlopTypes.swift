import Foundation

struct SlopHello: Decodable, Equatable {
  struct Provider: Decodable, Equatable {
    let id: String
    let name: String
    let slopVersion: String?
    let capabilities: [String]

    enum CodingKeys: String, CodingKey {
      case id
      case name
      case slopVersion = "slop_version"
      case capabilities
    }
  }

  let provider: Provider
}

struct SlopNode: Codable, Equatable, Identifiable {
  let id: String
  let type: String
  let properties: [String: JSONValue]?
  let children: [SlopNode]?
  let affordances: [SlopAffordance]?
  let contentRef: SlopContentRef?

  enum CodingKeys: String, CodingKey {
    case id
    case type
    case properties
    case children
    case affordances
    case contentRef = "content_ref"
  }

  func child(id childId: String) -> SlopNode? {
    children?.first { $0.id == childId }
  }

  func propertyString(_ key: String) -> String? {
    properties?.string(key)
  }

  func propertyBool(_ key: String) -> Bool? {
    properties?.bool(key)
  }

  func propertyInt(_ key: String) -> Int? {
    properties?.int(key)
  }
}

struct SlopAffordance: Codable, Equatable {
  let action: String
  let label: String?
  let description: String?
  let dangerous: Bool?
  let idempotent: Bool?
}

struct SlopContentRef: Codable, Equatable {
  let type: String
  let mime: String
  let size: Int?
  let uri: String?
  let summary: String
  let encoding: String?
}

struct SlopResult: Decodable, Equatable {
  struct SlopError: Decodable, Equatable {
    let code: String
    let message: String
  }

  let status: String
  let data: JSONValue?
  let error: SlopError?
}

struct TranscriptMessage: Equatable, Identifiable {
  let id: String
  let role: String
  let state: String
  let turnId: String?
  let text: String

  static func parse(_ node: SlopNode) -> TranscriptMessage? {
    guard let role = node.propertyString("role"), let state = node.propertyString("state") else {
      return nil
    }
    let turnId = node.propertyString("turn_id")
    let content = node.child(id: "content")
    let text = content?.children?
      .compactMap { block in
        guard block.type == "document" else {
          return nil
        }
        return block.propertyString("text")
      }
      .joined(separator: "\n") ?? ""
    return TranscriptMessage(id: node.id, role: role, state: state, turnId: turnId, text: text)
  }
}

struct VoiceInputState: Equatable {
  var state = "unknown"
  var activeAdapterId = ""
  var activeModel = ""
  var language = "auto"
  var availableAdapters: [String] = []
  var lastError: String?

  static func parse(_ node: SlopNode) -> VoiceInputState {
    let props = node.properties ?? [:]
    return VoiceInputState(
      state: props.string("state") ?? "unknown",
      activeAdapterId: props.string("active_adapter_id") ?? "",
      activeModel: props.string("active_model") ?? "",
      language: props.string("language") ?? "auto",
      availableAdapters: props["available_adapters"]?.arrayValue?.compactMap(\.stringValue) ?? [],
      lastError: props.string("last_error")
    )
  }
}

struct VoiceOutputState: Equatable {
  var state = "unknown"
  var activeAdapterId = ""
  var activeModel = ""
  var voice = ""
  var format = "wav"
  var availableAdapters: [String] = []
  var lastError: String?

  static func parse(_ node: SlopNode) -> VoiceOutputState {
    let props = node.properties ?? [:]
    return VoiceOutputState(
      state: props.string("state") ?? "unknown",
      activeAdapterId: props.string("active_adapter_id") ?? "",
      activeModel: props.string("active_model") ?? "",
      voice: props.string("voice") ?? "",
      format: props.string("format") ?? "wav",
      availableAdapters: props["available_adapters"]?.arrayValue?.compactMap(\.stringValue) ?? [],
      lastError: props.string("last_error")
    )
  }
}

struct SendMessageOutcome: Equatable {
  let status: String
  let turnId: String?
  let queuedMessageId: String?
  let position: Int?

  static func parse(_ result: SlopResult) -> SendMessageOutcome {
    let data = result.data?.objectValue ?? [:]
    return SendMessageOutcome(
      status: data.string("status") ?? result.status,
      turnId: data.string("turnId") ?? data.string("turn_id"),
      queuedMessageId: data.string("queuedMessageId") ?? data.string("queued_message_id"),
      position: data.int("position")
    )
  }
}
