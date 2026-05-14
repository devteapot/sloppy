import Foundation

@MainActor
final class SloppySessionClient {
  private let client = SlopClient()
  private(set) var socketPath: String

  init(socketPath: String) {
    self.socketPath = socketPath
  }

  func connect() async throws {
    _ = try await client.connect(socketPath: socketPath)
  }

  func disconnect() {
    client.disconnect()
  }

  func query(_ path: String, depth: Int) async throws -> SlopNode {
    try await client.query(path: path, depth: depth)
  }

  @discardableResult
  func subscribe(_ path: String, depth: Int, onInvalidate: @escaping () -> Void) async throws -> SlopNode {
    try await client.subscribe(path: path, depth: depth, onInvalidate: onInvalidate)
  }

  func sendMessage(_ text: String) async throws -> SendMessageOutcome {
    let result = try await client.invoke(
      path: "/composer",
      action: "send_message",
      params: ["text": .string(text)]
    )
    return SendMessageOutcome.parse(result)
  }

  func queryVoice(_ path: String, depth: Int) async throws -> SlopNode {
    let result = try await client.invoke(
      path: "/apps",
      action: "query_provider",
      params: [
        "provider_id": .string("voice"),
        "path": .string(path),
        "depth": .number(Double(depth)),
      ]
    )
    guard let data = result.data else {
      throw SlopClientError.invalidResponse("voice query returned no data")
    }
    return try data.decode(SlopNode.self)
  }

  func invokeVoice(_ path: String, action: String, params: [String: JSONValue] = [:]) async throws -> SlopResult {
    let result = try await client.invoke(
      path: "/apps",
      action: "invoke_provider",
      params: [
        "provider_id": .string("voice"),
        "path": .string(path),
        "action": .string(action),
        "params": .object(params),
      ]
    )
    return try unwrapProviderResult(result)
  }

  private func unwrapProviderResult(_ result: SlopResult) throws -> SlopResult {
    guard
      let data = result.data,
      let object = data.objectValue,
      object.string("type") == "result",
      object.string("status") != nil
    else {
      return result
    }

    let inner = try data.decode(SlopResult.self)
    if inner.status == "error" {
      throw SlopClientError.providerError(inner.error?.message ?? "Voice provider returned an error.")
    }
    return inner
  }
}
