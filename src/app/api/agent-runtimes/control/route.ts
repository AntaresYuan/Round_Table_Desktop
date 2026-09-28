import { z } from 'zod';
import { stopRuntimeConversation } from '@/server/actions/runtime-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const BodySchema = z.object({
  conversationId: z.string().min(1),
  action: z.enum(['stop']),
});

export async function POST(req: Request) {
  try {
    await requireProductionActor();
    const body = BodySchema.parse(await req.json());
    if (body.action === 'stop') {
      return Response.json({ ok: true, conversation: await stopRuntimeConversation(body.conversationId) });
    }
    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
