import { z } from 'zod';
import { rejectHandoff } from '@/server/actions/mission-actions';
import { jsonError, routeActor } from '@/server/route-utils';

const BodySchema = z.object({
  handoffId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const actor = await routeActor();
    if (!actor) throw new Error('unauthorized');
    const body = BodySchema.parse(await req.json());
    return Response.json({ ok: true, mission: await rejectHandoff(actor, body.handoffId) });
  } catch (error) {
    return jsonError(error);
  }
}
