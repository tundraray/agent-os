/** Russian noun forms for a count: «один» (1, 21), «несколько» (2–4, 22), «много» (5–20, 25, 0). */
export type PluralFormsRu = readonly [one: string, few: string, many: string];

const rules = new Intl.PluralRules('ru-RU');

/** The form of the noun that agrees with `count`; fractional counts take the «few» form («1,5 вызова»). */
export function pluralRu(count: number, [one, few, many]: PluralFormsRu): string {
  switch (rules.select(count)) {
    case 'one':
      return one;
    case 'many':
      return many;
    default:
      return few;
  }
}
