import { listTurns } from '@/server/actions/turn-actions';
import { jsonError, routeActor } from '@/server/route-utils';

export async function GET(req: Request) {
  try {
    const actor = await routeActor();
    if (!actor) throw new Error('unauthorized');
    const url = new URL(req.url);
    const chatId = url.searchParams.get('chatId') ?? undefined;
    return Response.json({ ok: true, turns: await listTurns(chatId, { actor }) });
  } catch (error) {
    return jsonError(error);
  }
}
