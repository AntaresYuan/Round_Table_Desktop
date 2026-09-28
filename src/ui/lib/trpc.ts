import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@/server/root';

// Typed tRPC React hooks for the frontend. Used inside the client Providers.
export const trpc = createTRPCReact<AppRouter>();
