import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { apiBaseUrl } from '@/lib/config';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin', 'cyrillic'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin', 'cyrillic'],
});

export const metadata: Metadata = {
  title: 'Agent OS',
  description: 'Рабочее пространство Agent OS',
};

export const viewport: Viewport = {
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

// Keeps <meta name="theme-color"> equal to the page background: re-reads the computed
// --background whenever next-themes changes the class on <html>. Static, no user data.
const THEME_COLOR_SCRIPT = `(function(){var html=document.documentElement;var meta=document.querySelector('meta[name="theme-color"]');if(!meta){meta=document.createElement('meta');meta.setAttribute('name','theme-color');document.head.appendChild(meta);}function update(){var color=getComputedStyle(html).getPropertyValue('--background').trim();if(color)meta.setAttribute('content',color);}new MutationObserver(update).observe(html,{attributes:true,attributeFilter:['class']});window.addEventListener('load',update);update();})();`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="ru"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href={apiBaseUrl} crossOrigin="use-credentials" />
        <script dangerouslySetInnerHTML={{ __html: THEME_COLOR_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
