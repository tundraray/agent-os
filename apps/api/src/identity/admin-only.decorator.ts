import { SetMetadata } from '@nestjs/common';

export const IS_ADMIN_ONLY = 'identity:admin-only';

/** Lets only an employee with the admin right through (KD-3); others get 403 ADMIN_REQUIRED. */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_ADMIN_ONLY, true);
