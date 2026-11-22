import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { LoginHeading } from '@/components/auth/login-heading';

type LoginQuery = PageProps<'/login'>['searchParams'];

const firstOf = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** uxrd Screen 1: a page of its own, outside the (chat) shell. */
export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <main className="flex min-h-svh flex-col items-center bg-background px-4 pt-[16svh] pb-12">
      <div className="flex w-full max-w-[400px] flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            ◆ Agent OS
          </p>
          <LoginHeading />
        </div>
        {/* The query is request data: with cacheComponents it is read inside a Suspense boundary. */}
        <Suspense fallback={null}>
          <LoginFormFromQuery searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function LoginFormFromQuery({
  searchParams,
}: {
  searchParams: LoginQuery;
}) {
  const query = await searchParams;
  return (
    <LoginForm
      reason={firstOf(query.reason)}
      error={firstOf(query.error)}
      provider={firstOf(query.provider)}
      next={firstOf(query.next)}
    />
  );
}
