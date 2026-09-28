import { z } from 'zod';
import { deleteTurn } from '@/server/actions/turn-actions';
import { jsonError, routeActor } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await routeActor();
    return Response.json({ ok: true, ...(await deleteTurn(body.turnId, { actor })) });
  } catch (error) {
    return jsonError(error);
  }
}
