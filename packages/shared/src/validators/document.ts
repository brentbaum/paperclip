import { z } from "zod";

export const createDocumentRevisionSchema = z.object({
  baseRevisionId: z.string().uuid().nullable().optional(),
  body: z.string(),
  changeSummary: z.string().nullable().optional(),
  source: z.string().min(1).optional().default("user_edit"),
});

export type CreateDocumentRevision = z.infer<typeof createDocumentRevisionSchema>;

export const documentDiffQuerySchema = z.object({
  from: z.string().uuid().nullable().optional(),
  to: z.string().uuid().nullable().optional(),
});

export type DocumentDiffQuery = z.infer<typeof documentDiffQuerySchema>;

export const documentDayQuerySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type DocumentDayQuery = z.infer<typeof documentDayQuerySchema>;
