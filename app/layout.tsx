import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ded - notes',
  description: 'A quiet space for everything on your mind.',
  applicationName: 'ded - notes',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'ded - notes' },
  manifest: '/manifest.json',
};
export const viewport: Viewport = { themeColor: '#f7f7f5', width: 'device-width', initialScale: 1 };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
