/** Providers of `WorkflowsModule`, the composition root of the workflows package in `apps/api` (design-workflows.md, C3). */

/**
 * The assembled workflows package (`Workflows` of `@agent-os/workflows`): the template catalog and the
 * run reader. Its factory registers the templates' definitions and `start_workflow` in `agents`.
 */
export const WORKFLOWS = Symbol('WORKFLOWS');
