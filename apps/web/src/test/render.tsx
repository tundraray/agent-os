import type { JSXElementConstructor, ReactNode } from 'react';
import {
  render as baseRender,
  renderHook as baseRenderHook,
  type RenderHookOptions,
  type RenderHookResult,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import { TestIntlProvider } from './intl';

export * from '@testing-library/react';

type Wrapper = JSXElementConstructor<{ children: ReactNode }>;

/** The test's own wrapper, if any, inside the interface-language provider. */
function withIntl(Inner: Wrapper | undefined): Wrapper {
  return function IntlWrapper({ children }: { children: ReactNode }) {
    return <TestIntlProvider>{Inner === undefined ? children : <Inner>{children}</Inner>}</TestIntlProvider>;
  };
}

/** Testing Library's `render` with the Russian interface-language provider around the UI. */
export function render(ui: ReactNode, options: Omit<RenderOptions, 'queries'> = {}): RenderResult {
  return baseRender(ui, { ...options, wrapper: withIntl(options.wrapper) });
}

/** Testing Library's `renderHook` with the Russian interface-language provider around the hook. */
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: RenderHookOptions<Props> = {},
): RenderHookResult<Result, Props> {
  return baseRenderHook(callback, { ...options, wrapper: withIntl(options.wrapper) });
}
