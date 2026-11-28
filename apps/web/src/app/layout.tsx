import { Suspense } from 'react';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { LocaleRoot } from '@/i18n/locale-root';
import { ThemeProvider } from '@/components/theme-provider';
import { THEME_COOKIE } from '@agent-os/contracts';
import { THEME_ATTRIBUTE } from '@/lib/theme';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

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
};

export const viewport: Viewport = {
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

// Runs before <body> is parsed: copies the theme cookie into data-theme on <html> unchecked, since an
// unknown id matches no theme block and leaves «Graphite»; then keeps <meta name="theme-color">
// equal to the computed --background whenever the theme attribute or the next-themes class changes.
// Built from constants, no request data, so the layout stays static (pre-paint-preference.md).
const THEME_SCRIPT = `(function(){var html=document.documentElement;var match=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);if(match)html.setAttribute('${THEME_ATTRIBUTE}',match[1]);var meta=document.querySelector('meta[name="theme-color"]');if(!meta){meta=document.createElement('meta');meta.setAttribute('name','theme-color');document.head.appendChild(meta);}function update(){var color=getComputedStyle(html).getPropertyValue('--background').trim();if(color)meta.setAttribute('content',color);}new MutationObserver(update).observe(html,{attributes:true,attributeFilter:['class','${THEME_ATTRIBUTE}']});window.addEventListener('load',update);update();})();`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          disableTransitionOnChange
        >
          {/* The language is request data: with cacheComponents it is read inside a Suspense boundary,
              and the language root fixes the static `lang` with an inline script (design-web.md, KD-2). */}
          <Suspense fallback={null}>
            <LocaleRoot>
              <TooltipProvider>{children}</TooltipProvider>
              <Toaster />
            </LocaleRoot>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
