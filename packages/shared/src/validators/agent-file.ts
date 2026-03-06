import { z } from "zod";

export const agentFilePathQuerySchema = z.object({
  path: z.string().trim().min(1),
});

export type AgentFilePathQuery = z.infer<typeof agentFilePathQuerySchema>;

export const updateAgentFileSchema = z.object({
  path: z.string().trim().min(1),
  body: z.string(),
});

export type UpdateAgentFile = z.infer<typeof updateAgentFileSchema>;
