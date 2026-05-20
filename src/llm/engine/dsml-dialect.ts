import type { LlmTool } from "@slop-ai/consumer/browser";

import type {
  ConversationMessage,
  MessageContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../types";

const DSML_START = "<｜DSML｜tool_calls>";
const DSML_END = "</｜DSML｜tool_calls>";
const DSML_INVOKE_START = "<｜DSML｜invoke";
const DSML_INVOKE_END = "</｜DSML｜invoke>";
const DSML_PARAMETER_START = "<｜DSML｜parameter";
const DSML_PARAMETER_END = "</｜DSML｜parameter>";
const DS4_BOS = "<｜begin▁of▁sentence｜>";
const DS4_EOS = "<｜end▁of▁sentence｜>";
const DS4_USER = "<｜User｜>";
const DS4_ASSISTANT = "<｜Assistant｜>";
const DS4_DISABLE_THINKING = "</think>";

type DsmlSyntax = {
  start: string;
  end: string;
  invokeStart: string;
  invokeEnd: string;
  parameterStart: string;
  parameterEnd: string;
};

const DSML_SYNTAXES: DsmlSyntax[] = [
  {
    start: DSML_START,
    end: DSML_END,
    invokeStart: DSML_INVOKE_START,
    invokeEnd: DSML_INVOKE_END,
    parameterStart: DSML_PARAMETER_START,
    parameterEnd: DSML_PARAMETER_END,
  },
  {
    start: "<DSML｜tool_calls>",
    end: "</DSML｜tool_calls>",
    invokeStart: "<DSML｜invoke",
    invokeEnd: "</DSML｜invoke>",
    parameterStart: "<DSML｜parameter",
    parameterEnd: "</DSML｜parameter>",
  },
  {
    start: "<tool_calls>",
    end: "</tool_calls>",
    invokeStart: "<invoke",
    invokeEnd: "</invoke>",
    parameterStart: "<parameter",
    parameterEnd: "</parameter>",
  },
];

export type DsmlParserEvent =
  | { type: "visible_text"; text: string }
  | { type: "tool_use"; block: ToolUseContentBlock };

export class DsmlDialect {
  readonly id = "dsml";

  renderPrompt(input: {
    system: string;
    messages: ConversationMessage[];
    tools: LlmTool[];
  }): string {
    const prompt: string[] = [DS4_BOS];
    const system = [input.system, this.renderToolInstructions(input.tools)]
      .filter(Boolean)
      .join("\n\n");
    if (system) {
      prompt.push(system);
    }

    let pendingAssistant = false;
    for (const message of input.messages) {
      if (message.role === "user") {
        prompt.push(DS4_USER, renderContent(message.content));
        pendingAssistant = true;
        continue;
      }

      if (pendingAssistant) {
        prompt.push(DS4_ASSISTANT, DS4_DISABLE_THINKING);
      }
      prompt.push(renderContent(message.content), DS4_EOS);
      pendingAssistant = false;
    }

    prompt.push(DS4_ASSISTANT, DS4_DISABLE_THINKING);
    return prompt.join("");
  }

  createParser(): DsmlParser {
    return new DsmlParser();
  }

  renderToolResult(result: ToolResultContentBlock): string {
    return [
      "<tool_result>",
      `tool_use_id: ${result.toolUseId}`,
      result.isError ? "status: error" : "status: ok",
      escapeToolResultContent(result.content),
      "</tool_result>",
    ].join("\n");
  }

  private renderToolInstructions(tools: LlmTool[]): string {
    if (tools.length === 0) {
      return "";
    }

    const schemas = tools.map((tool) => JSON.stringify(tool)).join("\n");
    return [
      "",
      "## Tools",
      "",
      "You have access to native DSML tools. Invoke tools by writing exactly this shape:",
      "",
      DSML_START,
      '<｜DSML｜invoke name="$TOOL_NAME">',
      '<｜DSML｜parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</｜DSML｜parameter>',
      "</｜DSML｜invoke>",
      DSML_END,
      "",
      'String parameters use raw text and string="true". Numbers, booleans, arrays, and objects use JSON text and string="false".',
      "Tool calls are not visible to the user. After tools run, use their observations to continue.",
      "",
      "### Available Tool Schemas",
      "",
      schemas,
    ].join("\n");
  }
}

export class DsmlParser {
  private buffer = "";
  private activeSyntax: DsmlSyntax | null = null;

  feed(text: string): DsmlParserEvent[] {
    this.buffer += text;
    return this.drain(false);
  }

  finish(): DsmlParserEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): DsmlParserEvent[] {
    const events: DsmlParserEvent[] = [];

    while (this.buffer.length > 0) {
      if (this.activeSyntax) {
        const syntax = this.activeSyntax;
        const endIndex = this.buffer.indexOf(syntax.end);
        if (endIndex === -1) {
          if (final) {
            const raw = this.buffer;
            this.buffer = "";
            this.activeSyntax = null;
            events.push(...malformedToolEvents("Incomplete DSML tool block.", raw));
          }
          return events;
        }

        const raw = this.buffer.slice(0, endIndex + syntax.end.length);
        this.buffer = this.buffer.slice(endIndex + syntax.end.length);
        this.activeSyntax = null;
        events.push(...parseToolBlock(raw, syntax));
        continue;
      }

      const start = findToolStart(this.buffer);
      if (start) {
        const visible = this.buffer.slice(0, start.index);
        if (visible) {
          events.push({ type: "visible_text", text: visible });
        }
        this.buffer = this.buffer.slice(start.index);
        this.activeSyntax = start.syntax;
        continue;
      }

      const keep = final ? 0 : longestStartPrefixSuffix(this.buffer);
      const visible = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (visible) {
        events.push({ type: "visible_text", text: visible });
      }
      return events;
    }

    return events;
  }
}

function renderContent(content: MessageContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "tool_use":
          return renderToolUse(block);
        case "tool_result":
          return new DsmlDialect().renderToolResult(block);
        case "image":
          return `[image:${block.mediaType}]`;
      }
      return "";
    })
    .join("\n");
}

function renderToolUse(block: ToolUseContentBlock): string {
  const params = Object.entries(block.input)
    .map(([name, value]) => renderParameter(name, value))
    .join("\n");
  return [
    DSML_START,
    `<｜DSML｜invoke name="${escapeAttribute(block.name)}">`,
    params,
    "</｜DSML｜invoke>",
    DSML_END,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderParameter(name: string, value: unknown): string {
  if (typeof value === "string") {
    return `<｜DSML｜parameter name="${escapeAttribute(name)}" string="true">${escapeStringParameterValue(value)}</｜DSML｜parameter>`;
  }

  return `<｜DSML｜parameter name="${escapeAttribute(name)}" string="false">${escapeJsonParameterValue(JSON.stringify(value))}</｜DSML｜parameter>`;
}

function parseToolBlock(raw: string, syntax: DsmlSyntax): DsmlParserEvent[] {
  const invokeRegex = new RegExp(
    `${escapeRegex(syntax.invokeStart)}\\s+name="([^"]+)"\\s*>([\\s\\S]*?)${escapeRegex(syntax.invokeEnd)}`,
    "g",
  );
  const events: DsmlParserEvent[] = [];
  let matched = false;

  for (const match of raw.matchAll(invokeRegex)) {
    matched = true;
    const name = unescapeAttribute(match[1] ?? "");
    const body = match[2] ?? "";
    const parsed = parseParameters(body, raw, syntax);
    events.push({
      type: "tool_use",
      block: {
        type: "tool_use",
        id: `engine-tool-${crypto.randomUUID()}`,
        name,
        input: parsed.input,
        ...(parsed.inputError ? { inputError: parsed.inputError } : {}),
      },
    });
  }

  if (!matched) {
    return malformedToolEvents("DSML tool block did not contain an invoke stanza.", raw);
  }

  return events;
}

function parseParameters(
  body: string,
  raw: string,
  syntax: DsmlSyntax,
): Pick<ToolUseContentBlock, "input" | "inputError"> {
  const paramRegex = new RegExp(
    `${escapeRegex(syntax.parameterStart)}\\s+name="([^"]+)"\\s+string="(true|false)"\\s*>([\\s\\S]*?)${escapeRegex(syntax.parameterEnd)}`,
    "g",
  );
  const input: Record<string, unknown> = {};

  for (const match of body.matchAll(paramRegex)) {
    const name = unescapeAttribute(match[1] ?? "");
    const stringMode = match[2] === "true";
    const value = unescapeParameterValue(match[3] ?? "");
    if (stringMode) {
      input[name] = value;
      continue;
    }

    try {
      input[name] = JSON.parse(value);
    } catch (error) {
      return {
        input,
        inputError: {
          code: "invalid_json",
          message: `DSML parameter '${name}' was not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          raw,
        },
      };
    }
  }

  return { input };
}

function malformedToolEvents(message: string, raw: string): DsmlParserEvent[] {
  return [
    {
      type: "tool_use",
      block: {
        type: "tool_use",
        id: `engine-tool-${crypto.randomUUID()}`,
        name: "invalid_dsml_tool_call",
        input: {},
        inputError: {
          code: "invalid_json",
          message,
          raw,
        },
      },
    },
  ];
}

function findToolStart(text: string): { index: number; syntax: DsmlSyntax } | null {
  let best: { index: number; syntax: DsmlSyntax } | null = null;
  for (const syntax of DSML_SYNTAXES) {
    const index = text.indexOf(syntax.start);
    if (index === -1) {
      continue;
    }
    if (!best || index < best.index) {
      best = { index, syntax };
    }
  }
  return best;
}

function longestStartPrefixSuffix(text: string): number {
  const max = Math.min(
    text.length,
    Math.max(...DSML_SYNTAXES.map((syntax) => syntax.start.length)) - 1,
  );
  for (let size = max; size > 0; size -= 1) {
    const suffix = text.slice(text.length - size);
    if (DSML_SYNTAXES.some((syntax) => syntax.start.startsWith(suffix))) {
      return size;
    }
  }
  return 0;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function escapeStringParameterValue(value: string): string {
  return value.replaceAll(DSML_PARAMETER_END, "&lt;/｜DSML｜parameter>");
}

function escapeJsonParameterValue(value: string): string {
  return value.replaceAll(DSML_PARAMETER_END, "\\u003c/｜DSML｜parameter>");
}

function unescapeParameterValue(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function escapeToolResultContent(value: string): string {
  return value.replaceAll("</tool_result>", "&lt;/tool_result>");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
