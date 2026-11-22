import { describe, expect, it } from 'vitest';
import { RegisterMcpServerBodySchema, UpdateMcpServerBodySchema } from './mcp';

// One row type for both bodies: the table mixes the two schemas.
type Row = {
  label: string;
  schema: { safeParse: (body: unknown) => { success: boolean } };
  body: Record<string, unknown>;
  valid: boolean;
};
const register = RegisterMcpServerBodySchema;
const update = UpdateMcpServerBodySchema;

const shared = {
  name: 'logs',
  url: 'https://mcp.example/mcp',
  mode: 'shared',
  sharedToken: 't',
};
const oauth = { name: 'github', url: 'https://mcp.example/mcp', mode: 'oauth' };

// INT-3 (provenAt: unit), DD Security Considerations / Input Validation: the schema is the boundary
// that keeps an invalid registry body from reaching the service.
describe('admin bodies: kebab name, http(s) url, a token only and always for shared, an update of status or token only', () => {
  it.each<Row>([
    {
      label: 'shared with a token',
      schema: register,
      body: shared,
      valid: true,
    },
    {
      label: 'oauth without a token',
      schema: register,
      body: oauth,
      valid: true,
    },
    {
      label: 'name not kebab-case',
      schema: register,
      body: { ...oauth, name: 'My_Server' },
      valid: false,
    },
    {
      label: 'http url',
      schema: register,
      body: { ...oauth, url: 'http://localhost:4100/mcp' },
      valid: true,
    },
    {
      label: 'ftp url',
      schema: register,
      body: { ...oauth, url: 'ftp://mcp.example/mcp' },
      valid: false,
    },
    {
      label: 'shared without a token',
      schema: register,
      body: { ...shared, sharedToken: undefined },
      valid: false,
    },
    {
      label: 'oauth with a token',
      schema: register,
      body: { ...oauth, sharedToken: 't' },
      valid: false,
    },
    {
      label: 'unknown mode',
      schema: register,
      body: { ...oauth, mode: 'stdio' },
      valid: false,
    },
    {
      label: 'update enabled',
      schema: update,
      body: { enabled: false },
      valid: true,
    },
    { label: 'empty update', schema: update, body: {}, valid: false },
    {
      label: 'update with name',
      schema: update,
      body: { enabled: true, name: 'other' },
      valid: false,
    },
    {
      label: 'update with url',
      schema: update,
      body: { enabled: true, url: 'https://x.example' },
      valid: false,
    },
    {
      label: 'update with mode',
      schema: update,
      body: { enabled: true, mode: 'oauth' },
      valid: false,
    },
  ])('$label -> valid: $valid', ({ schema, body, valid }) => {
    expect(schema.safeParse(body).success).toBe(valid);
  });
});
