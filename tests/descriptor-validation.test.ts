import { describe, expect, test } from "bun:test";

import { validateDescriptor } from "../src/providers/descriptor-validation";

describe("validateDescriptor", () => {
  test("valid descriptor passes validation", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
      transport: {
        type: "unix",
        path: "/tmp/test.sock",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result).toEqual({ valid: true });
  });

  test("missing id fails validation", () => {
    const descriptor = {
      name: "Test Provider",
      transport: {
        type: "unix",
        path: "/tmp/test.sock",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result.valid).toBe(false);

    if ("errors" in result) {
      expect(result.errors.some((e) => e.includes("id"))).toBe(true);
    }
  });

  test("missing transport fails validation", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
    };

    const result = validateDescriptor(descriptor);
    expect(result.valid).toBe(false);

    if ("errors" in result) {
      expect(result.errors.some((e) => e.includes("transport"))).toBe(true);
    }
  });

  test("missing transport.type fails validation", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
      transport: {
        path: "/tmp/test.sock",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result.valid).toBe(false);

    if ("errors" in result) {
      expect(result.errors.some((e) => e.includes("transport"))).toBe(true);
    }
  });

  test("missing transport.path and transport.url fails validation", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
      transport: {
        type: "unix",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result.valid).toBe(false);

    if ("errors" in result) {
      expect(result.errors.some((e) => e.includes("path"))).toBe(true);
    }
  });

  test("optional description does not cause failure", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
      description: "A test provider for validation",
      transport: {
        type: "unix",
        path: "/tmp/test.sock",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result).toEqual({ valid: true });
  });

  test("invalid capabilities type does not cause failure", () => {
    const descriptor = {
      id: "test-provider",
      name: "Test Provider",
      capabilities: ["read", "write"],
      transport: {
        type: "unix",
        path: "/tmp/test.sock",
      },
    };

    const result = validateDescriptor(descriptor);
    expect(result).toEqual({ valid: true });
  });
});
