import { checkPointer } from './pointer.js';

// DC-6 (FR-11, the rule half; the ownership half is research.verify, T2.4): a pointer names 1 to 20 records, each an
// integer position within its own page, none twice. Defect caught: a claim whose pointer names a record that is not on
// its page, a fractional number, nothing, more than 20 records or one record twice reaches the verifier call.

const PAGE_SIZES = new Map([
  ['p1', 3],
  ['p2', 30],
]);

describe('checkPointer: the pointer names records within its pages', () => {
  it.each<[string, unknown, boolean]>([
    ['records within their pages', [{ pageId: 'p1', records: [0, 2] }, { pageId: 'p2', records: [29] }], true],
    ['a number past the end of its page (it fits the other page)', [{ pageId: 'p1', records: [3] }], false],
    ['a negative number', [{ pageId: 'p1', records: [-1] }], false],
    ['a fractional number', [{ pageId: 'p1', records: [1.5] }], false],
    ['a page the investigation does not have', [{ pageId: 'p9', records: [0] }], false],
    ['an empty pointer', [], false],
    ['a page entry with no records', [{ pageId: 'p1', records: [] }], false],
    ['21 records', [{ pageId: 'p1', records: [0, 1] }, { pageId: 'p2', records: [...Array(19).keys()] }], false],
    ['20 records', [{ pageId: 'p1', records: [0] }, { pageId: 'p2', records: [...Array(19).keys()] }], true],
    ['the same record twice in one entry', [{ pageId: 'p1', records: [1, 1] }], false],
    ['the same record twice across entries of one page', [{ pageId: 'p1', records: [0] }, { pageId: 'p1', records: [0] }], false],
    ['not a pointer at all', { pageId: 'p1', records: [0] }, false],
  ])('%s', (_, pointer, valid) => {
    expect(checkPointer(pointer, PAGE_SIZES).valid).toBe(valid);
  });
});
