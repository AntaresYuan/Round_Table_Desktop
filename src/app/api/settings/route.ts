import { z } from 'zod';
import { listSettingsState, saveSettings } from '@/server/actions/settings-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const ProviderSchema = z.object({
  provider: z.string().min(1),
  enabled: z.boolean().optional(),
  label: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  clearApiKey: z.boolean().optional(),
});

const A2AAgentSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean().optional(),
  baseUrl: z.string().nullable().optional(),
  cardPath: z.string().nullable().optional(),
  authToken: z.string().nullable().optional(),
  clearAuthToken: z.boolean().optional(),
});

const BodySchema = z.object({
  defaultAgentAdapter: z.string().nullable().optional(),
  providers: z.array(ProviderSchema).optional(),
  a2aAgents: z.array(A2AAgentSchema).optional(),
});

export async function GET() {
  try {
    await requireProductionActor();
    return Response.json({ ok: true, state: await listSettingsState() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: Request) {
  try {
    await requireProductionActor();
    const body = BodySchema.parse(await req.json());
    return Response.json({ ok: true, state: await saveSettings(body) });
  } catch (error) {
    return jsonError(error);
  }
}
