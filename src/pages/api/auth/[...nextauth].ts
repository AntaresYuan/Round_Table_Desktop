import NextAuth from 'next-auth';
import type { NextApiRequest, NextApiResponse } from 'next';
import { applyDevelopmentAuthUrl, authOptions } from '@/server/auth';

export default function authHandler(req: NextApiRequest, res: NextApiResponse) {
  applyDevelopmentAuthUrl(req);
  return NextAuth(req, res, authOptions);
}
