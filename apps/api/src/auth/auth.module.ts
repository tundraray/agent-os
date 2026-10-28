import { Global, Module } from '@nestjs/common';
import { SessionGuard } from './session.guard.js';

@Global()
@Module({ providers: [SessionGuard], exports: [SessionGuard] })
export class AuthModule {}
