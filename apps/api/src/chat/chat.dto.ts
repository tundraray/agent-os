import type { ChatRequest } from '@agent-os/contracts';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class ChatDto implements ChatRequest {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  @IsArray()
  messages: unknown[];
}
