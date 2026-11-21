import { useTranslations } from 'next-intl';

/** TH-02: the greeting of an empty thread (slot `Welcome` of `Thread`); the suggestions TH-03 sit under the composer. */
export function ShellWelcome() {
  const t = useTranslations('shell.welcome');
  return (
    <div className="mb-6 flex flex-col items-center gap-2 px-2 text-center max-md:my-auto">
      <p className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both text-2xl font-semibold tracking-tight duration-300 motion-reduce:animate-none md:text-[28px]">
        {t('title')}
      </p>
      <p className="text-muted-foreground animate-in fade-in slide-in-from-bottom-2 fill-mode-both text-sm duration-300 [animation-delay:80ms] motion-reduce:animate-none">
        {t('hint')}
      </p>
    </div>
  );
}
