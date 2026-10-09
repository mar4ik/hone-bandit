import type { ReactNode } from 'react';

export const metadata = {
  title: 'Hone',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '48px 24px', maxWidth: 640 }}>{children}</body>
    </html>
  );
}
