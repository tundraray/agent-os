import { describe, expect, it } from 'vitest';

import { valueRows } from './value-rows';

describe('valueRows value formatting', () => {
  it.each([
    { name: 'a string stays plain text', value: 'Сбой выгрузки', shown: { kind: 'text', text: 'Сбой выгрузки' } },
    { name: 'a number reads as text', value: 42.5, shown: { kind: 'text', text: '42.5' } },
    { name: 'true reads the catalogue’s «да»', value: true, shown: { kind: 'message', key: 'values.yes' } },
    { name: 'false reads the catalogue’s «нет»', value: false, shown: { kind: 'message', key: 'values.no' } },
    { name: 'null reads as a dash', value: null, shown: { kind: 'text', text: '—' } },
    { name: 'an absent value reads as a dash', value: undefined, shown: { kind: 'text', text: '—' } },
    { name: 'an empty string reads as a dash', value: '', shown: { kind: 'text', text: '—' } },
    { name: 'a nested object is compact JSON', value: { id: 1, tags: ['a'] }, shown: { kind: 'json', text: '{"id":1,"tags":["a"]}' } },
    { name: 'an array is compact JSON', value: ['a', 2], shown: { kind: 'json', text: '["a",2]' } },
  ])('$name', ({ value, shown }) => {
    expect(valueRows({ key: value })?.[0]?.value).toEqual(shown);
  });
});
