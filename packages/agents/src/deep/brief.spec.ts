import { expect, it } from 'vitest';

import { taskQuestion } from './brief';

it.each([
  ['{"question":"Why did checkout fail?","boundaries":"","result":""}'],
  ['Why did checkout fail?'],
])('a task is shown as its question: %s', (text) => {
  expect(taskQuestion(text)).toBe('Why did checkout fail?');
});
