import { AuthPage } from '@/ui/components/auth-page';

type SignInPageProps = {
  searchParams?: Promise<{
    callbackUrl?: string;
    error?: string;
  }>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  return <AuthPage mode="signin" callbackUrl={params?.callbackUrl} authError={params?.error} />;
}
