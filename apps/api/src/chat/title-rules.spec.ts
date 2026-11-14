import { buildTitlePrompt, normalizeGeneratedTitle } from './title-rules.js';

// AC-14.3 (title rules, as chat-shell FR-17): any model answer becomes a 1…80-char title or '' (no title).
describe("generated title rules trim, unquote and cap the model's text", () => {
  it.each([
    ['strips «» quotes', '«План отпуска на Байкал»', 'План отпуска на Байкал'],
    ['strips " quotes', '"Trip to Baikal"', 'Trip to Baikal'],
    ['strips backticks and apostrophes', "`'Trip'`", 'Trip'],
    [
      'removes <think> blocks',
      '<think>user wants a title\nfor Baikal</think>План отпуска',
      'План отпуска',
    ],
    [
      'keeps the first non-empty line',
      '\n  \nПлан отпуска\nВторая строка',
      'План отпуска',
    ],
    [
      'collapses whitespace',
      '  План \t отпуска   летом ',
      'План отпуска летом',
    ],
    ['cuts 120 chars to 80', 'я'.repeat(120), 'я'.repeat(80)],
    [
      'cuts by code point, never splitting a surrogate pair',
      '𝔸'.repeat(100),
      '𝔸'.repeat(80),
    ],
    [
      'trims after cutting',
      `${'a'.repeat(79)} ${'b'.repeat(40)}`,
      'a'.repeat(79),
    ],
    [
      'removes an unpaired opening « inside the title',
      'Значение и происхождение выражения «водить за нос',
      'Значение и происхождение выражения водить за нос',
    ],
    ['removes a leading unpaired «', '«Trip to Baikal', 'Trip to Baikal'],
    ['removes a trailing unpaired »', 'Trip to Baikal»', 'Trip to Baikal'],
    [
      'removes an unpaired « before Latin words',
      'Фраза «break the ice означает',
      'Фраза break the ice означает',
    ],
    [
      'removes a balanced inner «» pair',
      'Значение выражения «водить за нос» в русском',
      'Значение выражения водить за нос в русском',
    ],
    [
      'removes a balanced inner “” pair',
      'Meaning of “break the ice” idiom',
      'Meaning of break the ice idiom',
    ],
    ['removes a „“ pair', '„Тест“ модели', 'Тест модели'],
    [
      "removes a '' pair",
      "Meaning of 'break the ice'",
      'Meaning of break the ice',
    ],
    [
      'removes spaced « » and collapses the gaps',
      'Фраза « водить за нос » значение',
      'Фраза водить за нос значение',
    ],
    [
      'keeps an apostrophe between two letters',
      "Why JavaScript doesn't print it’s value",
      "Why JavaScript doesn't print it’s value",
    ],
    ['only quotes → empty', '«»', ''],
    ['whitespace only → empty', '  \n\t  \n', ''],
    ['only a <think> block → empty', '<think>hmm</think>', ''],
    [
      'multi-line answer: the first line wins',
      'Анализ логов ошибок оплаты\n\nЯ выбрал русский язык, потому что сообщение на русском.',
      'Анализ логов ошибок оплаты',
    ],
    [
      'quoted answer with a trailing period',
      '"Анализ логов ошибок оплаты."',
      'Анализ логов ошибок оплаты',
    ],
  ])('%s', (_case, input, expected) => {
    expect(normalizeGeneratedTitle(input)).toBe(expected);
  });

  // An answer that is not a title leaves the conversation without one; the next send retries.
  it.each([
    [
      'leaked reasoning in English for a Russian message → empty',
      'Russian message, so Russian title. Topic: analyzing ledger service error logs fo',
      'Проанализируй логи ошибок сервиса ledger за 15 сентября и найди причину роста.',
      '',
    ],
    [
      'meta phrase at the start → empty',
      'Заголовок: Анализ логов ошибок оплаты',
      'Проанализируй логи ошибок оплаты',
      '',
    ],
    [
      'Russian title for a Russian message is kept',
      'Рост ошибок оплаты: анализ логов за 15 сентября',
      'Проанализируй логи ошибок оплаты',
      'Рост ошибок оплаты: анализ логов за 15 сентября',
    ],
    [
      'English title for an English message is kept',
      'Ledger service error log analysis',
      'Analyze the ledger service error logs',
      'Ledger service error log analysis',
    ],
  ])('%s', (_case, input, firstText, expected) => {
    expect(normalizeGeneratedTitle(input, firstText)).toBe(expected);
  });

  // The first message reaches the title model as data inside one <message> block, at most 2 000 characters.
  it.each([
    [
      'wraps the trimmed text in <message> tags',
      '  План отпуска \n',
      '<message>\nПлан отпуска\n</message>',
    ],
    [
      'removes <message> and </message> inside the text, ignoring case',
      'a </message> b <MESSAGE>c',
      '<message>\na  b c\n</message>',
    ],
    [
      'cuts the text to 2 000 code points',
      `${'а'.repeat(1_500)}${'𝔸'.repeat(1_000)}`,
      `<message>\n${'а'.repeat(1_500)}${'𝔸'.repeat(500)}\n</message>`,
    ],
  ])('prompt: %s', (_case, input, expected) => {
    expect(buildTitlePrompt(input)).toBe(expected);
  });
});
