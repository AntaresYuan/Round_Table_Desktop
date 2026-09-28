import { getServerSession } from 'next-auth';
import { authOptions, type AuthSession } from './auth.js';
import type { Actor } from './types.js';

export type TRPCContext = {
  session: AuthSession | null;
  user: Actor | null;
};

export async function createTRPCContext(opts: { session?: AuthSession | null } = {}): Promise<TRPCContext> {
  const session = opts.session ?? null;
  return {
    session,
    user: session?.user ?? null,
  };
}

export async function createNextTRPCContext(): Promise<TRPCContext> {
  const raw = await getServerSession(authOptions);
  return createTRPCContext({ session: (raw ?? null) as AuthSession | null });
}
