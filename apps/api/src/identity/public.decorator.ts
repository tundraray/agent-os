import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'identity:public';

/**
 * Takes the session check off a route (KD-3): such a route protects itself. Every route without it
 * needs a session, so a forgotten mark refuses rather than opens.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);
