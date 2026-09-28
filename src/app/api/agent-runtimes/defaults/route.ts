import { z } from 'zod';
import { saveRuntimeDefaultConfig } from '@/server/actions/runtime-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const BodySchema = z.object({
  runtime: z.string().min(1),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  clearEnv: z.boolean().optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  interactionMode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await requireProductionActor();
    const config = await saveRuntimeDefaultConfig({ ...body, actor });
    return Response.json({
      ok: true,
      config: {
        runtime: config.runtime,
        command: config.command,
        args: config.args,
        model: config.model,
        modelProvider: config.modelProvider,
        interactionMode: config.interactionMode,
        effort: config.effort,
        configuredEnvKeys: Object.keys(config.env).sort(),
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
