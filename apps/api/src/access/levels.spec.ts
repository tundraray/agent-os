import {
  grantsOfLevel,
  levelOf,
  type LevelGrant,
  type ServerLevel,
} from './levels';

const S = 'tracker';

const allowServer: LevelGrant = {
  effect: 'allow',
  target: { kind: 'server', server: S },
};
const denyServer: LevelGrant = {
  effect: 'deny',
  target: { kind: 'server', server: S },
};
const allowRead: LevelGrant = {
  effect: 'allow',
  target: { kind: 'server_read', server: S },
};
const toolRow = (tool: string, effect: 'allow' | 'deny'): LevelGrant => ({
  effect,
  target: { kind: 'tool', server: S, tool },
});

// UC-1: AC-37.3, AC-37.7, AC-40.1, AC-40.2 — the rows of the derivation table, both ways.
describe('level derivation: each kind of rows is one level, and saving the level writes the same rows back', () => {
  it.each<{ name: string; rows: LevelGrant[]; level: ServerLevel }>([
    { name: 'no rows is none', rows: [], level: { level: 'none', marks: [] } },
    {
      name: 'a server_read allow is read',
      rows: [allowRead],
      level: { level: 'read', marks: [] },
    },
    {
      name: 'a server allow is all',
      rows: [allowServer],
      level: { level: 'all', marks: [] },
    },
    {
      name: 'a server deny is denied',
      rows: [denyServer],
      level: { level: 'denied', marks: [] },
    },
    {
      name: 'tool rows of a role are pick with allow marks',
      rows: [toolRow('create', 'allow'), toolRow('list', 'allow')],
      level: {
        level: 'pick',
        marks: [
          { tool: 'create', effect: 'allow' },
          { tool: 'list', effect: 'allow' },
        ],
      },
    },
    {
      name: 'tool rows of an employee are pick with allow and deny marks',
      rows: [toolRow('create', 'deny'), toolRow('list', 'allow')],
      level: {
        level: 'pick',
        marks: [
          { tool: 'create', effect: 'deny' },
          { tool: 'list', effect: 'allow' },
        ],
      },
    },
    {
      // AC-37.7: the derivation does not know the list, so a mark of a tool gone from the server stays.
      name: 'a mark of a tool the server no longer lists stays a mark',
      rows: [toolRow('ghost', 'allow')],
      level: { level: 'pick', marks: [{ tool: 'ghost', effect: 'allow' }] },
    },
  ])('$name', ({ rows, level }) => {
    expect(levelOf(rows)).toEqual(level);
    expect(grantsOfLevel(S, level)).toEqual(rows);
  });

  it.each<{ name: string; rows: LevelGrant[]; level: ServerLevel['level'] }>([
    {
      name: 'a server deny beats every other kind',
      rows: [toolRow('create', 'allow'), allowRead, allowServer, denyServer],
      level: 'denied',
    },
    {
      name: 'a server allow beats server_read and tool rows',
      rows: [toolRow('create', 'allow'), allowRead, allowServer],
      level: 'all',
    },
    {
      name: 'server_read beats tool rows',
      rows: [toolRow('create', 'allow'), allowRead],
      level: 'read',
    },
  ])('mixed rows: $name', ({ rows, level }) => {
    expect(levelOf(rows)).toEqual({ level, marks: [] });
  });

  it('saves pick without marks as none: no rows', () => {
    expect(grantsOfLevel(S, { level: 'pick', marks: [] })).toEqual([]);
  });
});
