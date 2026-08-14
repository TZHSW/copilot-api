import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

// Reverse of translateModelName: dot form → hyphen form so Claude Code's
// hardcoded capability registry recognizes the model ids.
// e.g. claude-opus-4.7-1m-internal → claude-opus-4-7-1m-internal
function toHyphenForm(id: string): string {
  return id.replace(
    /^(claude-(?:opus|sonnet|haiku)-(\d+))\.(\d+)/,
    "$1-$3",
  )
}

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      await cacheModels()
    }

    const models = state.models?.data.flatMap((model) => {
      const hyphenId = toHyphenForm(model.id)
      //透传完整模型信息，只替换 id 为连字号形式
      const entry = { ...model, id: hyphenId }
      const entries = [entry]

      // For -1m or -1m-internal models, also emit a [1m] alias so CC
      // recognizes them as 1M-context variants (e.g. claude-opus-4-7[1m]).
      const match = hyphenId.match(/^(claude-[\w-]+-\d+-\d+)-1m(?:-internal)?$/)
      if (match) {
        entries.push({ ...model, id: `${match[1]}[1m]` })
      }

      return entries
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
