import { z } from 'zod';
import { startDirectRuntimeConversation } from '@/server/actions/runtime-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const BodySchema = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
  workspacePath: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    await requireProductionActor();
    const body = BodySchema.parse(await req.json());
    return Response.json({ ok: true, conversation: await startDirectRuntimeConversation(body) });
  } catch (error) {
    return jsonError(error);
  }
}
