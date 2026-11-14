import { describe, expect, it } from 'vitest';

import { formatValue } from './value-rows';

describe('formatValue', () => {
  it.each([
    { name: 'a string stays plain text', value: 'Сбой выгрузки', text: 'Сбой выгрузки', json: false },
    { name: 'a number reads as text', value: 42.5, text: '42.5', json: false },
    { name: 'true reads «да»', value: true, text: 'да', json: false },
    { name: 'false reads «нет»', value: false, text: 'нет', json: false },
    { name: 'null reads as a dash', value: null, text: '—', json: false },
    { name: 'an absent value reads as a dash', value: undefined, text: '—', json: false },
    { name: 'an empty string reads as a dash', value: '', text: '—', json: false },
    { name: 'a nested object is compact JSON', value: { id: 1, tags: ['a'] }, text: '{"id":1,"tags":["a"]}', json: true },
    { name: 'an array is compact JSON', value: ['a', 2], text: '["a",2]', json: true },
  ])('$name', ({ value, text, json }) => {
    expect(formatValue(value)).toEqual({ text, json });
  });
});
