import { normalizeAdapter } from '@/server/actions/agent-runner';
import { jsonError, requireProductionActor } from '@/server/route-utils';

export async function GET() {
  try {
    await requireProductionActor();
    return Response.json({
      ok: true,
      backend: 'clean-action-layer',
      defaultAdapter: normalizeAdapter(undefined),
      cliCommand: process.env.ROUNDTABLE_AGENT_COMMAND || 'claude',
    });
  } catch (error) {
    return jsonError(error);
  }
}
