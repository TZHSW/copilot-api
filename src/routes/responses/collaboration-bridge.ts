import type { ResponsesPayload } from "~/services/copilot/create-responses"

const PUBLIC_NAMESPACE = "collaboration"
export const COLLABORATION_ALIAS = "codex_collaboration_plaintext"
const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"])

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as JsonObject)
    : undefined
}

function plaintextTool(value: unknown): unknown {
  const tool = object(value)
  if (
    !tool
    || tool.type !== "function"
    || !MESSAGE_TOOLS.has(String(tool.name))
  )
    return value
  const parameters = object(tool.parameters)
  const properties = object(parameters?.properties)
  const message = object(properties?.message)
  if (!message) return value
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: { ...properties, message: { ...message, encrypted: false } },
    },
  }
}

// Codex Responses Lite places tool definitions in input[type=additional_tools]. Both
// surfaces must use the same alias; only the three message arguments change.
export function bridgeCollaborationRequest(payload: ResponsesPayload): {
  payload: ResponsesPayload
  active: boolean
} {
  const changedNamespaces: Array<string> = []
  const mapTools = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value
    if (value.some((entry) => object(entry)?.name === COLLABORATION_ALIAS)) {
      throw new Error(
        "Collaboration bridge namespace conflicts with a client tool",
      )
    }
    return value.map((entry: unknown) => {
      const namespace = object(entry)
      if (
        namespace?.type !== "namespace"
        || namespace.name !== PUBLIC_NAMESPACE
        || !Array.isArray(namespace.tools)
      )
        return entry
      changedNamespaces.push(PUBLIC_NAMESPACE)
      return {
        ...namespace,
        name: COLLABORATION_ALIAS,
        tools: namespace.tools.map((tool: unknown) => plaintextTool(tool)),
      }
    })
  }
  const tools = mapTools(payload.tools)
  const input =
    Array.isArray(payload.input) ?
      payload.input.map((entry: unknown) => {
        const item = object(entry)
        return item?.type === "additional_tools" ?
            { ...item, tools: mapTools(item.tools) }
          : entry
      })
    : payload.input
  if (changedNamespaces.length === 0) return { payload, active: false }

  const renameCall = (value: unknown): unknown => {
    const item = object(value)
    if (
      item?.namespace === PUBLIC_NAMESPACE
      && (item.type === "function_call" || item.type === "function_call_output")
    ) {
      return { ...item, namespace: COLLABORATION_ALIAS }
    }
    return value
  }
  const toolChoice = object(payload.tool_choice)
  const choice =
    toolChoice?.namespace === PUBLIC_NAMESPACE ?
      { ...toolChoice, namespace: COLLABORATION_ALIAS }
    : payload.tool_choice
  return {
    active: true,
    payload: {
      ...payload,
      ...(payload.tools === undefined ? {} : { tools }),
      input:
        Array.isArray(input) ?
          input.map((item: unknown) => renameCall(item))
        : input,
      ...(choice === undefined ? {} : { tool_choice: choice }),
    },
  }
}

function restoreCall(value: unknown): unknown {
  const item = object(value)
  if (item?.type !== "function_call" || item.namespace !== COLLABORATION_ALIAS)
    return value
  if (MESSAGE_TOOLS.has(String(item.name))) {
    if (
      Array.isArray(item.encrypted_function_args)
      && item.encrypted_function_args.length > 0
    ) {
      throw new Error(
        "Upstream returned encrypted arguments for a plaintext collaboration tool",
      )
    }
    // Codex requires an explicit empty list to treat the message as plaintext.
    // Omitting this field makes the client store even plain text as ciphertext.
    return { ...item, namespace: PUBLIC_NAMESPACE, encrypted_function_args: [] }
  }
  return { ...item, namespace: PUBLIC_NAMESPACE }
}

export function restoreCollaborationResponse(value: unknown): unknown {
  const record = object(value)
  if (!record) return value
  if (record.type === "function_call") return restoreCall(record)
  const restored = { ...record }
  if (record.item !== undefined) restored.item = restoreCall(record.item)
  if (Array.isArray(record.output))
    restored.output = record.output.map((item: unknown) => restoreCall(item))
  if (record.response !== undefined)
    restored.response = restoreCollaborationResponse(record.response)
  if (
    typeof record.type === "string"
    && record.type.startsWith("response.function_call_arguments.")
    && record.namespace === COLLABORATION_ALIAS
  )
    restored.namespace = PUBLIC_NAMESPACE
  return restored
}

function restoreEvent(frame: string): string {
  const separator = frame.includes("\r\n") ? "\r\n" : "\n"
  const lines = frame.split(separator)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return frame
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return frame
  }
  const restored = restoreCollaborationResponse(parsed)
  if (JSON.stringify(restored) === JSON.stringify(parsed)) return frame
  const index = lines.findIndex((line) => line.startsWith("data:"))
  return lines
    .flatMap((line, i) => {
      if (i === index) return [`data: ${JSON.stringify(restored)}`]
      return line.startsWith("data:") ? [] : [line]
    })
    .join(separator)
}

export function bridgeCollaborationStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let pending = ""
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk
          let boundary: RegExpExecArray | null
          while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
            controller.enqueue(
              restoreEvent(pending.slice(0, boundary.index)) + boundary[0],
            )
            pending = pending.slice(boundary.index + boundary[0].length)
          }
        },
        flush(controller) {
          if (pending) controller.enqueue(restoreEvent(pending))
        },
      }),
    )
    .pipeThrough(new TextEncoderStream())
}

export async function bridgeCollaborationBody(
  response: Response,
  headers: Headers,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!response.ok || !response.body) return response.body
  const contentType = headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    headers.set("x-copilot-collaboration-mode", "plaintext")
    return bridgeCollaborationStream(response.body)
  }
  if (contentType.includes("application/json")) {
    const restored = restoreCollaborationResponse(await response.json())
    headers.set("x-copilot-collaboration-mode", "plaintext")
    return new Response(JSON.stringify(restored)).body
  }
  return response.body
}
