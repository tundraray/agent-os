import type { ChatRequest } from '@agent-os/contracts';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ChatDto implements ChatRequest {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  threadId?: string;

  @IsArray()
  messages: unknown[];
}
