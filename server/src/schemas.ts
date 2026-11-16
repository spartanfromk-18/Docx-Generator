import { z } from "zod";

/** Zod request validation — request bodies reject unknown properties (TRD S5 / API 2.4). */

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const devLoginSchema = strict({
  email: z.string().trim().toLowerCase().email().max(254),
  display_name: z.string().trim().min(1).max(120).optional(),
});

export const refreshSchema = strict({ refresh_token: z.string().min(10).max(4096) });
export const switchOrgSchema = strict({ org_id: z.string().uuid() });

export const createOrgSchema = strict({
  name: z.string().trim().min(1).max(120),
});

export const createProjectSchema = strict({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  idea_text: z.string().max(20000).optional(),
  language: z.string().trim().min(2).max(8).default("en"),
});

export const updateProjectSchema = strict({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  language: z.string().trim().min(2).max(8).optional(),
});

export const listProjectsQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
});

export const createSourceSchema = strict({
  url: z.string().trim().min(8).max(2048).regex(/^https?:\/\//i, "URL must start with http(s)://"),
  attestation: z.literal(true),
  max_pages: z.coerce.number().int().min(1).max(50).default(25),
  respect_robots: z.literal(true).default(true),
});

export const confirmSourceSchema = z.object({}).strict().default({});

export const DOC_TYPES = ["PRD", "TRD", "UIUX", "SCHEMA"] as const;

export const createRunSchema = strict({
  mode: z.enum(["idea", "reference"]),
  idea: z.string().min(1).max(20000).optional(),
  source_id: z.string().uuid().optional(),
  documents: z.array(z.enum(DOC_TYPES)).min(1).max(4).default([...DOC_TYPES]),
  language: z.string().trim().min(2).max(8).default("en"),
  intake: z
    .object({
      audience: z.string().max(200).optional(),
      core_problem: z.string().max(200).optional(),
      must_have_features: z.string().max(200).optional(),
      scale_goal: z.string().max(200).optional(),
      stack_preference: z.string().max(200).optional(),
      compliance_needs: z.string().max(200).optional(),
    })
    .strict()
    .default({}),
});

export const retryStageParams = z.object({
  id: z.string().uuid(),
  stage: z.string().min(3).max(32),
});

export const createVersionSchema = strict({
  base_version_no: z.coerce.number().int().min(1),
  sections: z
    .array(
      strict({
        id: z.string().uuid(),
        body_md: z.string().min(1).max(50000),
      }),
    )
    .min(1)
    .max(50),
  change_note: z.string().trim().max(500).optional(),
});

export const regenerateSectionSchema = strict({
  instruction: z.string().trim().max(500).optional(),
});

export const createExportSchema = strict({
  format: z.enum(["docx", "md", "pdf"]),
});

export const createBundleSchema = strict({
  formats: z.array(z.enum(["docx", "md"])).min(1).max(2).default(["docx", "md"]),
});

export const createShareLinkSchema = strict({
  expires_in_days: z.coerce.number().int().min(1).max(365).default(30),
  password: z.string().trim().min(4).max(128).optional(),
});

export const shareUnlockSchema = strict({
  password: z.string().min(1).max(128),
});

export const checkoutSchema = strict({
  kind: z.enum(["plan", "pack"]),
  plan: z.enum(["pro", "team"]).optional(),
  credits: z.coerce.number().int().optional(),
});

export const createApiKeySchema = strict({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(["runs:write", "runs:read", "documents:read", "documents:write", "projects:read", "projects:write"])).min(1).max(6),
});

export const stripeWebhookSchema = z.object({
  id: z.string().min(3).max(256),
  type: z.string().min(3).max(128),
  created: z.number().int().optional(),
  data: z.object({ object: z.record(z.unknown()).optional() }).passthrough().optional(),
});

/** Structured-output schemas the LLM must satisfy (validated by the gateway). */
export const llmDocumentSchema = z.object({
  title: z.string().min(3).max(200),
  sections: z
    .array(
      z.object({
        heading: z.string().min(2).max(200),
        body_md: z.string().min(20).max(20000),
      }),
    )
    .min(3)
    .max(20),
});

export const llmGlossarySchema = z.object({
  canonical: z.record(z.string().min(2).max(60)),
  entities: z
    .array(z.object({ name: z.string().min(2).max(60), definition: z.string().min(10).max(400) }))
    .min(2)
    .max(12),
});
