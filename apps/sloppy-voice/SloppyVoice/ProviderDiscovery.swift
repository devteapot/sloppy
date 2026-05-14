import Foundation

struct ProviderCandidate: Equatable, Identifiable {
  enum Kind: Equatable {
    case supervisor
    case session
  }

  let id: String
  let name: String
  let socketPath: String
  let kind: Kind
}

private struct ProviderDescriptor: Decodable {
  struct Transport: Decodable {
    let type: String
    let path: String?
  }

  let id: String
  let name: String
  let transport: Transport
}

enum ProviderDiscovery {
  static var defaultDirectory: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".slop")
      .appendingPathComponent("providers")
  }

  static func discover(in directory: URL = defaultDirectory) -> [ProviderCandidate] {
    guard let files = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    ) else {
      return []
    }

    return files
      .filter { $0.pathExtension == "json" }
      .compactMap { url -> ProviderCandidate? in
        guard
          let data = try? Data(contentsOf: url),
          let descriptor = try? JSONDecoder().decode(ProviderDescriptor.self, from: data),
          descriptor.transport.type == "unix",
          let socketPath = descriptor.transport.path
        else {
          return nil
        }

        if descriptor.id == "sloppy-session-supervisor" {
          return ProviderCandidate(
            id: descriptor.id,
            name: descriptor.name,
            socketPath: socketPath,
            kind: .supervisor
          )
        }

        if descriptor.id.hasPrefix("sloppy-session-") {
          return ProviderCandidate(
            id: descriptor.id,
            name: descriptor.name,
            socketPath: socketPath,
            kind: .session
          )
        }

        return nil
      }
      .sorted { left, right in
        if left.kind != right.kind {
          return left.kind == .supervisor
        }
        return left.id < right.id
      }
  }

  static func preferredCandidate(in directory: URL = defaultDirectory) -> ProviderCandidate? {
    discover(in: directory).first
  }
}
