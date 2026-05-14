import Foundation
import Network

enum SlopClientError: LocalizedError {
  case notConnected
  case connectionFailed(String)
  case connectionClosed
  case invalidResponse(String)
  case providerError(String)

  var errorDescription: String? {
    switch self {
    case .notConnected:
      return "Not connected to a SLOP provider."
    case .connectionFailed(let message):
      return "SLOP connection failed: \(message)"
    case .connectionClosed:
      return "SLOP connection closed."
    case .invalidResponse(let message):
      return "Invalid SLOP response: \(message)"
    case .providerError(let message):
      return message
    }
  }
}

struct LineBuffer {
  private var buffer = Data()

  mutating func append(_ data: Data) -> [String] {
    buffer.append(data)
    var lines: [String] = []

    while let newlineIndex = buffer.firstIndex(of: 0x0a) {
      let lineData = buffer[..<newlineIndex]
      buffer.removeSubrange(...newlineIndex)
      if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
        lines.append(line)
      }
    }

    return lines
  }
}

private struct QueryMessage: Encodable {
  let type = "query"
  let id: String
  let path: String
  let depth: Int
}

private struct SubscribeMessage: Encodable {
  let type = "subscribe"
  let id: String
  let path: String
  let depth: Int
}

private struct InvokeMessage: Encodable {
  let type = "invoke"
  let id: String
  let path: String
  let action: String
  let params: [String: JSONValue]?
}

private struct ProviderMessage: Decodable {
  let type: String
  let id: String?
  let provider: SlopHello.Provider?
  let version: Int?
  let seq: Int?
  let tree: SlopNode?
  let status: String?
  let data: JSONValue?
  let error: SlopResult.SlopError?
  let subscription: String?
}

@MainActor
final class SlopClient {
  private let queue = DispatchQueue(label: "ai.slop.sloppy-voice.slop-client")
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private var connection: NWConnection?
  private var lineBuffer = LineBuffer()
  private var connectContinuation: CheckedContinuation<SlopHello, Error>?
  private var pendingSnapshots: [String: CheckedContinuation<SlopNode, Error>] = [:]
  private var pendingResults: [String: CheckedContinuation<SlopResult, Error>] = [:]
  private var subscriptions: [String: () -> Void] = [:]

  func connect(socketPath: String) async throws -> SlopHello {
    disconnect()
    let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
    self.connection = connection

    connection.stateUpdateHandler = { [weak self] state in
      Task { @MainActor in
        self?.handleConnectionState(state)
      }
    }

    receiveLoop(on: connection)
    connection.start(queue: queue)

    return try await withCheckedThrowingContinuation { continuation in
      connectContinuation = continuation
    }
  }

  func disconnect() {
    connection?.cancel()
    connection = nil
    failPending(SlopClientError.connectionClosed)
  }

  func query(path: String, depth: Int) async throws -> SlopNode {
    let id = UUID().uuidString
    let message = QueryMessage(id: id, path: path, depth: depth)
    return try await withCheckedThrowingContinuation { continuation in
      pendingSnapshots[id] = continuation
      do {
        try send(message)
      } catch {
        pendingSnapshots.removeValue(forKey: id)
        continuation.resume(throwing: error)
      }
    }
  }

  @discardableResult
  func subscribe(path: String, depth: Int, onInvalidate: @escaping () -> Void) async throws -> SlopNode {
    let id = UUID().uuidString
    subscriptions[id] = onInvalidate
    let message = SubscribeMessage(id: id, path: path, depth: depth)
    return try await withCheckedThrowingContinuation { continuation in
      pendingSnapshots[id] = continuation
      do {
        try send(message)
      } catch {
        subscriptions.removeValue(forKey: id)
        pendingSnapshots.removeValue(forKey: id)
        continuation.resume(throwing: error)
      }
    }
  }

  func invoke(path: String, action: String, params: [String: JSONValue]? = nil) async throws -> SlopResult {
    let id = UUID().uuidString
    let message = InvokeMessage(id: id, path: path, action: action, params: params)
    return try await withCheckedThrowingContinuation { continuation in
      pendingResults[id] = continuation
      do {
        try send(message)
      } catch {
        pendingResults.removeValue(forKey: id)
        continuation.resume(throwing: error)
      }
    }
  }

  private func send<T: Encodable>(_ message: T) throws {
    guard let connection else {
      throw SlopClientError.notConnected
    }
    var data = try encoder.encode(message)
    data.append(0x0a)
    connection.send(content: data, completion: .contentProcessed { error in
      if let error {
        Task { @MainActor in
          self.failPending(SlopClientError.connectionFailed(error.localizedDescription))
        }
      }
    })
  }

  private func receiveLoop(on connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self, weak connection] data, _, isComplete, error in
      guard let self, let connection else {
        return
      }

      if let data, !data.isEmpty {
        Task { @MainActor in
          self.handleData(data)
        }
      }

      if let error {
        Task { @MainActor in
          self.failPending(SlopClientError.connectionFailed(error.localizedDescription))
        }
        return
      }

      if isComplete {
        Task { @MainActor in
          self.failPending(SlopClientError.connectionClosed)
        }
        return
      }

      Task { @MainActor in
        self.receiveLoop(on: connection)
      }
    }
  }

  private func handleConnectionState(_ state: NWConnection.State) {
    switch state {
    case .failed(let error):
      failPending(SlopClientError.connectionFailed(error.localizedDescription))
    case .cancelled:
      failPending(SlopClientError.connectionClosed)
    default:
      break
    }
  }

  private func handleData(_ data: Data) {
    for line in lineBuffer.append(data) {
      do {
        let message = try decoder.decode(ProviderMessage.self, from: Data(line.utf8))
        try handle(message)
      } catch {
        failPending(SlopClientError.invalidResponse(error.localizedDescription))
      }
    }
  }

  private func handle(_ message: ProviderMessage) throws {
    switch message.type {
    case "hello":
      guard let provider = message.provider else {
        throw SlopClientError.invalidResponse("hello missing provider")
      }
      connectContinuation?.resume(returning: SlopHello(provider: provider))
      connectContinuation = nil
    case "snapshot":
      guard let id = message.id, let tree = message.tree else {
        throw SlopClientError.invalidResponse("snapshot missing id or tree")
      }
      pendingSnapshots.removeValue(forKey: id)?.resume(returning: tree)
      if pendingSnapshots[id] == nil, subscriptions[id] != nil {
        subscriptions[id]?()
      }
    case "patch":
      if let subscription = message.subscription {
        subscriptions[subscription]?()
      }
    case "result":
      guard let id = message.id, let status = message.status else {
        throw SlopClientError.invalidResponse("result missing id or status")
      }
      let result = SlopResult(status: status, data: message.data, error: message.error)
      if status == "error" {
        let message = result.error?.message ?? "Provider returned an error."
        pendingResults.removeValue(forKey: id)?.resume(throwing: SlopClientError.providerError(message))
      } else {
        pendingResults.removeValue(forKey: id)?.resume(returning: result)
      }
    case "error":
      let errorMessage = message.error?.message ?? "Provider returned an error."
      if let id = message.id {
        pendingSnapshots.removeValue(forKey: id)?.resume(throwing: SlopClientError.providerError(errorMessage))
        pendingResults.removeValue(forKey: id)?.resume(throwing: SlopClientError.providerError(errorMessage))
      } else {
        failPending(SlopClientError.providerError(errorMessage))
      }
    case "event":
      break
    default:
      break
    }
  }

  private func failPending(_ error: Error) {
    connectContinuation?.resume(throwing: error)
    connectContinuation = nil
    for continuation in pendingSnapshots.values {
      continuation.resume(throwing: error)
    }
    pendingSnapshots.removeAll()
    for continuation in pendingResults.values {
      continuation.resume(throwing: error)
    }
    pendingResults.removeAll()
  }
}
