import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as ts from "typescript";

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function propertyAssignment(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) === name) {
      return property;
    }
  }
  return null;
}

function hasProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return propertyAssignment(object, name) !== null;
}

function hasStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  value: string,
): boolean {
  const property = propertyAssignment(object, name);
  return property
    ? ts.isStringLiteral(property.initializer) && property.initializer.text === value
    : false;
}

function findArraySchemasWithoutItems(sourceFile: ts.SourceFile): string[] {
  const missing: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isObjectLiteralExpression(node) &&
      hasStringProperty(node, "type", "array") &&
      !hasProperty(node, "items")
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      missing.push(`${relative(process.cwd(), sourceFile.fileName)}:${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return missing;
}

describe("built-in provider affordance schemas", () => {
  test("first-party array parameter schemas declare items explicitly", async () => {
    const files = await collectTypeScriptFiles(join(process.cwd(), "src", "providers", "builtin"));
    const missing = (
      await Promise.all(
        files.map(async (file) => {
          const source = await readFile(file, "utf8");
          return findArraySchemasWithoutItems(
            ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
          );
        }),
      )
    ).flat();

    expect(missing).toEqual([]);
  });
});
