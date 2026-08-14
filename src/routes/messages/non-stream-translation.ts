import { state } from "~/lib/state"

import {
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const translatedModel = translateModelName(payload.model)
  const reasoningFields = translateReasoningFields(payload, translatedModel)

  return {
    model: translatedModel,
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    ...reasoningFields,
  }
}

/**
 * Translate Anthropic's thinking/effort fields into Copilot's reasoning
 * fields. Only emits fields if the target model supports reasoning.
 *
 * Anthropic side:
 *   - output_config.effort  → effort tier (new path, Opus 4.6+)
 *   - thinking.budget_tokens → effort tier (legacy path, Opus 4.5)
 *   - thinking.type          → adaptive / enabled / disabled
 *
 * Copilot side:
 *   - reasoning_effort  → effort tier string
 *   - reasoning.effort  → effort tier object (triggers reasoning_text return)
 *   - thinking          → adaptive/enabled thinking mode
 */
function translateReasoningFields(
  payload: AnthropicMessagesPayload,
  translatedModel: string,
): Partial<ChatCompletionsPayload> {
  if (!modelSupportsReasoning(translatedModel)) return {}

  const effort =
    translateOutputConfigEffort(payload.output_config?.effort) ??
    translateThinkingToReasoningEffort(payload.thinking)

  const thinking = translateThinking(payload.thinking)

  return {
    ...(effort && { reasoning_effort: effort }),
    ...(effort && { reasoning: { effort } }),
    ...(thinking && { thinking }),
  }
}

/**
 * Translate Anthropic's `output_config.effort` to a reasoning effort tier.
 * Maps "max" → "xhigh" (Copilot doesn't expose "max").
 */
function translateOutputConfigEffort(
  effort: AnthropicMessagesPayload["output_config"] extends infer T
    ? T extends { effort?: infer E }
      ? E
      : never
    : never,
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (!effort) return undefined
  // Copilot doesn't currently expose "max"; map to xhigh (highest available).
  return effort === "max" ? "xhigh" : effort
}

/**
 * Translate Anthropic's `thinking` field to Copilot's format.
 *
 * Anthropic sends:
 *   - {type: "adaptive"}           — new path, model decides thinking depth
 *   - {type: "enabled", budget_tokens: N} — legacy path, explicit budget
 *   - {type: "disabled"}           — explicitly off
 *
 * Copilot accepts the same structure on Claude models, so we pass through
 * adaptive/enabled and drop disabled (no point sending it).
 */
function translateThinking(
  thinking: AnthropicMessagesPayload["thinking"],
): ChatCompletionsPayload["thinking"] | undefined {
  if (!thinking || thinking.type === "disabled") return undefined
  return thinking
}

/**
 * Translate Anthropic's `thinking.budget_tokens` to Copilot's
 * `reasoning_effort` tier.
 *
 * Budget thresholds match Claude Code's `--effort` flag mapping:
 *   low      → budget ≈ 1024 (Anthropic minimum)
 *   medium   → budget ≈ 8K
 *   high     → budget ≈ 16K-32K
 *   xhigh    → budget ≈ 64K (Claude Code default on Opus 4.7/4.8)
 */
function translateThinkingToReasoningEffort(
  thinking: AnthropicMessagesPayload["thinking"],
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (!thinking || thinking.type !== "enabled") return undefined

  const budget = thinking.budget_tokens ?? 0
  if (budget >= 50000) return "xhigh"
  if (budget >= 16000) return "high"
  if (budget >= 4096) return "medium"
  return "low"
}

/**
 * Translate the model id from Claude-Code-internal hyphenated form
 * (e.g. `claude-opus-4-7`, `claude-opus-4-7[1m]`) into the Copilot
 * Enterprise catalog form (dotted, plus Microsoft-internal 1m variant).
 *
 * Background: Claude Code's internal model registry uses hyphenated ids
 * (`claude-opus-4-7`, `claude-sonnet-4-6`) for sub-agent dispatch, tool
 * routing, and the `[1m]` syntactic-suffix for 1M-context variants
 * (`claude-opus-4-7[1m]`, `claude-opus-4-6[1m]`). The Copilot Enterprise
 * catalog uses DOTTED ids (`claude-opus-4.7`, `claude-opus-4.6`,
 * `claude-opus-4.7-1m-internal`). The original upstream copilot-api
 * 0.7.0 translation collapses every hyphenated opus to bare
 * `claude-opus-4` and every hyphenated sonnet to `claude-sonnet-4`,
 * both of which 400 on Copilot — so every sub-agent / tool-routing
 * call silently failed before this patch.
 *
 * Translation table (verified against Copilot catalog 2026-06-03) — HISTORICAL.
 * The catalog has since dropped every -1m / -1m-internal variant (checked
 * 2026-08-14: claude-opus-4.6/4.7/4.8/5, claude-sonnet-4.6/5, claude-haiku-4.5,
 * nothing with a 1M suffix). The code below resolves variants from the live
 * catalog rather than from this table, so it degrades to the base model on its
 * own; the table is kept to show what the mapping looks like when the internal
 * variants are present.
 *
 *   claude-opus-4-7[1m]    → claude-opus-4.7-1m-internal  (xhigh-capable)
 *   claude-opus-4-7        → claude-opus-4.7              (medium-only)
 *   claude-opus-4-8[1m]    → claude-opus-4.7-1m-internal  (no 4.8 1M yet, use 4.7-1m)
 *   claude-opus-4-8        → claude-opus-4.8              (medium-only)
 *   claude-opus-4-6[1m]    → claude-opus-4.6-1m
 *   claude-opus-4-6        → claude-opus-4.6
 *   claude-opus-4-5[…]     → claude-opus-4.5              (no effort spectrum)
 *   claude-sonnet-4-6[…]   → claude-sonnet-4.6            (no 1M sonnet on Copilot)
 *   claude-sonnet-4-5      → claude-sonnet-4.5
 *   claude-haiku-4-5       → claude-haiku-4.5             (catalog has it, no effort)
 *
 * Pass-through: anything already in dotted form (`claude-opus-4.7-1m-internal`,
 * `claude-opus-4.8`, `gpt-5.5`, etc.) is returned unchanged.
 */
function catalogHasModel(id: string): boolean {
  return state.models?.data.some((m) => m.id === id) ?? false
}

// Check if the translated model supports reasoning_effort via catalog capabilities.
function modelSupportsReasoning(translatedModel: string): boolean {
  const model = state.models?.data.find((m) => m.id === translatedModel)
  const re = (model?.capabilities as Record<string, unknown>)?.supports as
    | Record<string, unknown>
    | undefined
  return Array.isArray(re?.reasoning_effort)
}

// Try to find the 1M variant of a model in the catalog.
// Returns the 1M catalog id, or the original model if no 1M variant exists.
function resolve1mVariant(base: string): string {
  const candidates = [`${base}-1m-internal`, `${base}-1m`]
  return candidates.find(catalogHasModel) ?? base
}

function translateModelName(model: string): string {
  // Strip date suffixes (e.g. `-20251001`).
  const undated = model.replace(/-\d{8}$/, "")

  // Strip `[1m]` suffix, remember it was there.
  const has1m = undated.endsWith("[1m]")
  const base = has1m ? undated.slice(0, -"[1m]".length) : undated

  // Normalize hyphen form → dot form for the version number only.
  // claude-opus-4-7        → claude-opus-4.7
  // claude-opus-4-7-1m     → claude-opus-4.7-1m
  // claude-opus-4-7-1m-internal → claude-opus-4.7-1m-internal
  // Already-dotted forms pass through unchanged.
  const normalized = base.replace(
    /^(claude-(?:opus|sonnet|haiku)-(\d+))-(\d+)/,
    "$1.$3",
  )

  // Restore [1m] → best available 1M variant in catalog
  if (has1m && !normalized.includes("-1m")) {
    return resolve1mVariant(normalized)
  }

  // Bare opus models (no -1m suffix): on Anthropic's official API these
  // are natively 1M-context. Copilot splits them into a 200K base and a
  // separate 1M variant. Route bare names to the 1M variant so behavior
  // matches the official API. Falls back to base if no 1M variant exists.
  // Any major version, not just 4.x — opus 5 shipped after this was written.
  if (!normalized.includes("-1m") && /^claude-opus-\d+\.\d+$/.test(normalized)) {
    return resolve1mVariant(normalized)
  }

  return normalized
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Merge content from all choices
  const allThinkingBlocks: Array<AnthropicThinkingBlock> = []
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract reasoning, text, and tool use blocks
  for (const choice of response.choices) {
    // Copilot reasoning models emit chain-of-thought in a separate
    // `reasoning_text` field on the message. Surface it as an Anthropic
    // `thinking` content block so Claude Code sees the model's actual
    // reasoning instead of silently dropping ~5-10K tokens per response.
    // The matching `reasoning_opaque` field becomes the thinking
    // signature, which Anthropic clients can echo back on follow-up
    // turns to keep the CoT cached server-side.
    if (choice.message.reasoning_text) {
      allThinkingBlocks.push({
        type: "thinking",
        thinking: choice.message.reasoning_text,
        ...(choice.message.reasoning_opaque && {
          signature: choice.message.reasoning_opaque,
        }),
      })
    }

    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    // Anthropic ordering convention: thinking blocks first, then text,
    // then tool_use. Claude Code parses thinking blocks separately and
    // displays them in the TUI as collapsed reasoning sections.
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
