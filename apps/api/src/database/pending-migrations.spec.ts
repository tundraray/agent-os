import { findPendingMigrations } from './pending-migrations.js';

const file = (tag: string, hash: string, folderMillis: number) => ({
  tag,
  hash,
  folderMillis,
});
const applied = (hash: string, createdAt: number) => ({ hash, createdAt });

// ADR-0003 / AC-RT-3: a migration file is pending when the journal holds no record with the same
// raw-bytes hash. Timestamps decide nothing: the drizzle migrator skips a file whose timestamp is
// not after the last applied one, and such a file must still block the start.
describe('findPendingMigrations', () => {
  it.each([
    {
      name: 'a file with no journal record is pending',
      files: [
        file('0000_init', 'h-init', 100),
        file('0001_next', 'h-next', 200),
      ],
      journal: [applied('h-init', 100)],
      pending: ['0001_next'],
    },
    {
      name: 'an applied file whose bytes changed is pending',
      files: [file('0000_init', 'h-init-edited', 100)],
      journal: [applied('h-init', 100)],
      pending: ['0000_init'],
    },
    {
      name: 'a file timestamped before the last applied one (skipped by the migrator) is pending',
      files: [
        file('0000_init', 'h-init', 100),
        file('0001_rebased', 'h-rebased', 150),
        file('0002_last', 'h-last', 200),
      ],
      journal: [applied('h-init', 100), applied('h-last', 200)],
      pending: ['0001_rebased'],
    },
    {
      name: 'nothing is pending when every file is applied',
      files: [
        file('0000_init', 'h-init', 100),
        file('0001_next', 'h-next', 200),
      ],
      journal: [applied('h-init', 100), applied('h-next', 200)],
      pending: [],
    },
  ])('$name', ({ files, journal, pending }) => {
    expect(findPendingMigrations(files, journal)).toEqual(pending);
  });
});
