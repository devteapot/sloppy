import Foundation

enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }

  var objectValue: [String: JSONValue]? {
    if case .object(let value) = self {
      return value
    }
    return nil
  }

  var arrayValue: [JSONValue]? {
    if case .array(let value) = self {
      return value
    }
    return nil
  }

  var stringValue: String? {
    if case .string(let value) = self {
      return value
    }
    return nil
  }

  var boolValue: Bool? {
    if case .bool(let value) = self {
      return value
    }
    return nil
  }

  var intValue: Int? {
    if case .number(let value) = self {
      return Int(value)
    }
    return nil
  }

  func decode<T: Decodable>(_ type: T.Type) throws -> T {
    let data = try JSONEncoder().encode(self)
    return try JSONDecoder().decode(type, from: data)
  }
}

extension Dictionary where Key == String, Value == JSONValue {
  func string(_ key: String) -> String? {
    self[key]?.stringValue
  }

  func bool(_ key: String) -> Bool? {
    self[key]?.boolValue
  }

  func int(_ key: String) -> Int? {
    self[key]?.intValue
  }
}
