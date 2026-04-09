import { Tool } from "./tool"
import DESCRIPTION from "./clone.txt"
import z from "zod"
import { Session } from "../session"
import { MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { defer } from "@/util/defer"

const SUMMARY_INSTRUCTION = [
  "",
  "",
  "When you are done, you MUST end your response with a clear and concise summary of everything you did, including:",
  "- What changes you made and where",
  "- Any decisions or trade-offs you encountered",
  "- Anything the user should know or review",
].join("\n")

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the cloned agent to perform, written as if the user is asking"),
})

export const CloneTool = Tool.define("clone", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      await ctx.ask({
        permission: "clone",
        patterns: ["*"],
        always: ["*"],
        metadata: {
          description: params.description,
        },
      })

      // Fork the parent session to share full conversation context
      // Cuts off before the current assistant message (the one invoking clone)
      const forked = await Session.fork({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
      })

      // Mark as a child session of the parent
      await Session.setParentID({ sessionID: forked.id, parentID: ctx.sessionID })
      await Session.setTitle({ sessionID: forked.id, title: params.description + " (clone)" })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: forked.id,
          model,
        },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(forked.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const clonePrompt = params.prompt + SUMMARY_INSTRUCTION
      const promptParts = await SessionPrompt.resolvePromptParts(clonePrompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: forked.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        tools: {
          todowrite: false,
          todoread: false,
        },
        parts: promptParts,
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `session_id: ${forked.id}`,
        "",
        "<clone_result>",
        text,
        "</clone_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: forked.id,
          model,
        },
        output,
      }
    },
  }
})
