import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../canonical-json.js';
import type { Scenario } from './scenario-dataset.js';
import { ScenarioParamsSchema } from './scenario-params.js';

/** A set of scenarios as `loadScenarioSet` returns it; the fingerprint names its exact content. */
export interface ScenarioSet {
  name: string;
  /** 12 hex characters of SHA-256 of the canonical set content. */
  fingerprint: string;
  scenarios: Scenario[];
}

export type ScenarioSetRejection =
  /** No set file with this name. */
  | { reason: 'set_unknown'; detail: string }
  /** The file is not JSON or the generator rejects its parameters. */
  | { reason: 'set_rejected'; detail: string };

export type LoadScenarioSetResult = { ok: true; set: ScenarioSet } | ({ ok: false } & ScenarioSetRejection);

export interface LoadScenarioSetOptions {
  /** Directory of set files; the package's `scenario-sets/` when absent. */
  directory?: URL;
}

/** Set and scenario names are used as file names and in `FIXTURE_SCENARIO=<set>/<scenario>`. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FINGERPRINT_HEX_LENGTH = 12;
const PACKAGE_SET_DIRECTORY = new URL('../../scenario-sets/', import.meta.url);
const SET_FILE_EXTENSION = '.json';

const SetFileSchema = z.strictObject({
  scenarios: z
    .array(z.strictObject({ id: z.string().regex(NAME_PATTERN), params: ScenarioParamsSchema }))
    .min(1)
    .superRefine((scenarios, ctx) => {
      const seen = new Set<string>();
      scenarios.forEach((scenario, index) => {
        if (seen.has(scenario.id)) {
          ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate scenario id ${scenario.id}` });
        }
        seen.add(scenario.id);
      });
    }),
});

/**
 * Loads the set file `<name>.json`. An unknown name, a file that is not JSON and parameters the generator rejects
 * each give a refusal with its reason; the set itself is pure data, so the same file always yields the same set.
 */
export function loadScenarioSet(name: string, options: LoadScenarioSetOptions = {}): LoadScenarioSetResult {
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, reason: 'set_unknown', detail: `set name ${JSON.stringify(name)} is not a set name` };
  }
  const text = readSetFile(new URL(`${name}${SET_FILE_EXTENSION}`, options.directory ?? PACKAGE_SET_DIRECTORY));
  if (text === undefined) {
    return { ok: false, reason: 'set_unknown', detail: `no scenario set ${name}` };
  }
  const content = SetFileSchema.safeParse(parseJson(text));
  if (!content.success) {
    const issue = content.error.issues[0];
    return { ok: false, reason: 'set_rejected', detail: `set ${name}: ${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  const scenarios = content.data.scenarios.map(({ id, params }) => ({ setName: name, scenarioId: id, params }));
  return {
    ok: true,
    set: {
      name,
      fingerprint: sha256Hex(canonicalJson({ name, scenarios })).slice(0, FINGERPRINT_HEX_LENGTH),
      scenarios,
    },
  };
}

/**
 * The names of the set files in the directory (`<name>.json` with a set name), sorted; a file that does not load is
 * still listed, so the caller meets its refusal through `loadScenarioSet`. A missing directory lists nothing.
 */
export function listScenarioSets(options: LoadScenarioSetOptions = {}): string[] {
  const directory = options.directory ?? PACKAGE_SET_DIRECTORY;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(SET_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -SET_FILE_EXTENSION.length))
    .filter((name) => NAME_PATTERN.test(name))
    .sort();
}

function readSetFile(file: URL): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema rejects `undefined` with a reason at the root.
    return undefined;
  }
}
