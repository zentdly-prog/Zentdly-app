import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { logAgentEvent } from "@/domain/conversation/agentOps";
import { AGENT_TOOLS, executeTool, type AgentToolDeps } from "@/integrations/ai/tools";

// gpt-4o-mini keeps each round fast enough to finish within the serverless
// timeout (Vercel Hobby caps functions at ~10s). The tool-based architecture
// is the real quality lever; mini handles it well. Can move back to gpt-4o
// if the deployment runs on a plan with a longer maxDuration.
const AGENT_MODEL = "gpt-4o-mini";
const AGENT_TEMPERATURE = 0.3;
const MAX_TOOL_ROUNDS = 4;

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }
  // Cap per-request time + retries so a slow OpenAI call fails fast and is
  // logged as agent_error instead of silently hitting the function timeout.
  openaiClient ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 12_000,
    maxRetries: 1,
  });
  return openaiClient;
}

export interface RunAgentInput {
  systemPrompt: string;
  chatHistory: ChatCompletionMessageParam[];
  userMessage: string;
  deps: AgentToolDeps;
}

export async function runAgent(input: RunAgentInput): Promise<string> {
  const openai = getOpenAIClient();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: input.systemPrompt },
    ...input.chatHistory,
    { role: "user", content: input.userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await openai.chat.completions.create({
      model: AGENT_MODEL,
      temperature: AGENT_TEMPERATURE,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // No tool calls → this is the final assistant reply
    if (!assistantMsg.tool_calls?.length) {
      return (assistantMsg.content ?? "").trim() || "No pude generar una respuesta.";
    }

    // Execute each tool the model requested
    for (const call of assistantMsg.tool_calls as ChatCompletionMessageToolCall[]) {
      const fn = (call as unknown as { function: { name: string; arguments: string } }).function;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        parsedArgs = {};
      }

      let result: string;
      try {
        result = await executeTool(fn.name, parsedArgs, input.deps);
        await logAgentEvent(input.deps.db, {
          tenantId: input.deps.tenantId,
          conversationId: input.deps.conversationId,
          customerId: input.deps.customerId,
          eventType: "tool_completed",
          toolName: fn.name,
          payload: { args: parsedArgs, result: result.slice(0, 500) },
        });
      } catch (error) {
        result = `Error ejecutando ${fn.name}: ${error instanceof Error ? error.message : "unknown"}`;
        await logAgentEvent(input.deps.db, {
          tenantId: input.deps.tenantId,
          conversationId: input.deps.conversationId,
          customerId: input.deps.customerId,
          eventType: "tool_failed",
          toolName: fn.name,
          payload: { args: parsedArgs },
          error: error instanceof Error ? error.message : "unknown",
        });
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Exhausted tool rounds — force a final answer without tools
  const final = await openai.chat.completions.create({
    model: AGENT_MODEL,
    temperature: AGENT_TEMPERATURE,
    messages,
  });
  return (final.choices[0]?.message?.content ?? "").trim() || "No pude procesar tu consulta.";
}
