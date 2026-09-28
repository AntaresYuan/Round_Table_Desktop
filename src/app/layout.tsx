import type { ReactNode } from 'react';
import '@/ui/styles/tokens.css';
import { Providers } from '@/ui/components/providers';

export const metadata = {
  title: 'Roundtable',
  description: 'Multi-agent collaboration workbench',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-aesthetic="neutral" data-theme="light" data-density="balanced">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
