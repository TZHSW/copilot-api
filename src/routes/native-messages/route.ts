import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleNativeMessages } from "./handler"

export const nativeMessageRoutes = new Hono()

nativeMessageRoutes.post("/", async (c) => {
  try {
    return await handleNativeMessages(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
