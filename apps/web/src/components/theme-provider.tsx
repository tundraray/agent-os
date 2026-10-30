'use client';

import type { ComponentProps } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

type ThemeProviderProps = Omit<ComponentProps<typeof NextThemesProvider>, 'scriptProps'>;

// Evaluated separately on the server and in the browser: the server HTML gets an executable
// script (runs during parsing, before paint); client renders get an inert 'text/plain' one, so
// React does not warn about rendering <script>. next-themes puts suppressHydrationWarning on its
// <script>, so React accepts the differing `type` during hydration.
const scriptProps = { type: typeof window === 'undefined' ? 'text/javascript' : 'text/plain' } as const;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props} scriptProps={scriptProps}>
      {children}
    </NextThemesProvider>
  );
}
