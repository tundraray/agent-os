/** Background shown until the dynamic part of the shell streams in; makes no layout assumptions. */
export function ShellFallback() {
  return <div aria-hidden className="bg-background min-h-dvh w-full flex-1" />;
}
