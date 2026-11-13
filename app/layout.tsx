import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Fonts are committed in app/fonts (variable WOFF2, latin) so builds never depend on
// Google Fonts being reachable. Served from this site: no render-blocking request,
// works offline, and looks identical on macOS, Windows, Linux, Android and iOS.
const sans = localFont({
  src: './fonts/dm-sans-latin.woff2',
  weight: '400 700',
  style: 'normal',
  variable: '--font-sans',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});
const display = localFont({
  src: './fonts/manrope-latin.woff2',
  weight: '400 800',
  style: 'normal',
  variable: '--font-display',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'ded - notes',
  description: 'A quiet space for everything on your mind.',
  applicationName: 'ded - notes',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'ded - notes' },
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  other: { 'mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#171916' },
  ],
};

// Applies the saved/system theme before first paint (no light flash in dark mode).
const themeScript = `(function(){try{var p=localStorage.getItem('ded-notes-theme')||'system';var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.setAttribute('data-theme',d?'dark':'light');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }}/>
      </head>
      <body>{children}</body>
    </html>
  );
}
