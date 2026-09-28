import { listRuntimeState } from '@/server/actions/runtime-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

export async function GET() {
  try {
    await requireProductionActor();
    return Response.json({ ok: true, state: await listRuntimeState() });
  } catch (error) {
    return jsonError(error);
  }
}
