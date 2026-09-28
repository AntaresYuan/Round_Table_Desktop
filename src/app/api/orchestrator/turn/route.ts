import { z } from 'zod';
import { createTurn } from '@/server/actions/turn-actions';
import { jsonError, routeActor } from '@/server/route-utils';

const BodySchema = z.object({
  message: z.string().min(1),
  turnId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  workflowTemplateId: z.string().min(1).optional(),
  agentAdapter: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await routeActor();
    if (!actor) throw new Error('unauthorized');
    // Plan only — never dispatch here. A clarification-parked turn returns its
    // questions (answered via POST /clarify); a planned turn returns its plan in
    // the "awaiting approval" state. In both cases the user reviews the plan and
    // starts the run explicitly (POST /approval), so no agent runs unprompted.
    const turn = await createTurn({ ...body, actor });
    return Response.json(turn);
  } catch (error) {
    return jsonError(error);
  }
}
