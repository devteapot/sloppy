import type { LlmProfileManager } from "../../../llm/profile-manager";
import type { AssistantContentBlock } from "../../../llm/types";
import type { PrecedentTieBreakDecision, PrecedentTieBreaker } from "./types";

const LLM_TIEBREAK_POLICY_REF = "policy:spec_question:precedent_llm_tiebreak:v1";

function extractText(content: AssistantContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseDecisionJson(text: string): { equivalent?: unknown; reasoning?: unknown } | null {
  const trimmed = text.trim();
  const candidate =
    trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed
      : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { equivalent?: unknown; reasoning?: unknown })
      : null;
  } catch {
    return null;
  }
}

export function createLlmPrecedentTieBreaker(
  manager: LlmProfileManager,
  options: {
    profileId?: string;
    model?: string;
    maxTokens?: number;
  } = {},
): PrecedentTieBreaker {
  return async (input): Promise<PrecedentTieBreakDecision> => {
    try {
      const adapter = await manager.createAdapter(options.profileId, options.model);
      const response = await adapter.chat({
        system:
          "You judge whether a current SpecQuestion is materially equivalent to a stored precedent. Return only JSON with keys equivalent:boolean and reasoning:string. Accept only when applying the precedent answer is safe without asking the user.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    precedent: {
                      id: input.precedent.id,
                      question: input.precedent.question.text,
                      canonical_summary: input.precedent.question.canonical_summary,
                      answer: input.precedent.resolution.answer,
                      reasoning: input.precedent.resolution.reasoning,
                      structural_keys: input.match.structural_keys,
                    },
                    current_question: input.question,
                    match: {
                      score: input.match.score,
                      band: input.match.band,
                      score_source: input.match.score_source,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        ],
        maxTokens: options.maxTokens ?? 512,
      });
      const parsed = parseDecisionJson(extractText(response.content));
      return {
        equivalent: parsed?.equivalent === true,
        reasoning:
          typeof parsed?.reasoning === "string" && parsed.reasoning.trim().length > 0
            ? parsed.reasoning.trim()
            : "LLM tie-break did not return a parseable rationale.",
        policy_ref: LLM_TIEBREAK_POLICY_REF,
      };
    } catch (error) {
      return {
        equivalent: false,
        reasoning: `LLM tie-break unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        policy_ref: LLM_TIEBREAK_POLICY_REF,
      };
    }
  };
}
