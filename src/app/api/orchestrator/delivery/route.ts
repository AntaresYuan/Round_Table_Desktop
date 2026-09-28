import { z } from 'zod';
import { decideTurnFinalDelivery } from '@/server/actions/turn-actions';
import { jsonError, routeActor } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  decision: z.enum(['accept', 'repair', 'tests']),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await routeActor();
    if (!actor) throw new Error('unauthorized');
    return Response.json(await decideTurnFinalDelivery({ ...body, actor }));
  } catch (error) {
    return jsonError(error);
  }
}
