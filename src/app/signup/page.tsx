import { AuthPage } from '@/ui/components/auth-page';

type SignUpPageProps = {
  searchParams?: Promise<{
    callbackUrl?: string;
    error?: string;
  }>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams;
  return <AuthPage mode="signup" callbackUrl={params?.callbackUrl} authError={params?.error} />;
}
