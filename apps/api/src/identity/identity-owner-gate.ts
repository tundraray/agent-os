import { Injectable } from '@nestjs/common';
import { OwnerDisabledError, type OwnerGate } from '@agent-os/agents';
import { IdentityDirectory } from './identity-directory.js';

/**
 * `OwnerGate` of the agents package over the employees (design-identity.md KD-4, C3 api): one status
 * read by primary key before every model and tool call. A disabled or unknown owner — including old
 * non-UUID owners such as `dev-user` — is refused with `OwnerDisabledError`; the package logs the
 * refusal with the agent and the task.
 */
@Injectable()
export class IdentityOwnerGate implements OwnerGate {
  constructor(private readonly directory: IdentityDirectory) {}

  async check(ownerId: string): Promise<void> {
    if (!(await this.directory.isActive(ownerId))) {
      throw new OwnerDisabledError(ownerId);
    }
  }
}
