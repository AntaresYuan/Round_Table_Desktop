import { z } from 'zod';
import { saveAgentRuntimeConfig } from '@/server/actions/runtime-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const BodySchema = z.object({
  agentId: z.string().min(1),
  runtime: z.string().min(1),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  interactionMode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await requireProductionActor();
    return Response.json({ ok: true, config: await saveAgentRuntimeConfig({ ...body, actor }) });
  } catch (error) {
    return jsonError(error);
  }
}
