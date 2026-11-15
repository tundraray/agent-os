import { UpdateSignInSettingsBodySchema } from '@agent-os/contracts';

const VALID = {
  publicUrl: 'https://aos.example.com',
  idleMinutes: 480,
  absoluteMinutes: 1440,
};

// AC-07.5: PUT /api/admin/settings/sign-in accepts only limits within the bounds; anything else is 400, unchanged.
describe('SignInSettings bounds: idle 15..1440, absolute 60..43200, idle not above absolute, publicUrl https or http://localhost without a path', () => {
  it.each([
    { change: { idleMinutes: 15 }, accepted: true },
    { change: { idleMinutes: 14 }, accepted: false },
    { change: { idleMinutes: 1440, absoluteMinutes: 1440 }, accepted: true },
    { change: { idleMinutes: 1441, absoluteMinutes: 43200 }, accepted: false },
    { change: { idleMinutes: 480.5 }, accepted: false },
    { change: { idleMinutes: 15, absoluteMinutes: 60 }, accepted: true },
    { change: { idleMinutes: 15, absoluteMinutes: 59 }, accepted: false },
    { change: { absoluteMinutes: 43200 }, accepted: true },
    { change: { absoluteMinutes: 43201 }, accepted: false },
    { change: { idleMinutes: 61, absoluteMinutes: 60 }, accepted: false },
    { change: { publicUrl: null }, accepted: true },
    { change: { publicUrl: 'http://localhost:3000' }, accepted: true },
    { change: { publicUrl: 'http://aos.example.com' }, accepted: false },
    { change: { publicUrl: 'https://aos.example.com/' }, accepted: false },
    { change: { publicUrl: 'https://aos.example.com/api' }, accepted: false },
    { change: { publicUrl: 'https://aos.example.com?x=1' }, accepted: false },
    { change: { publicUrl: 'aos.example.com' }, accepted: false },
  ])('$change -> accepted $accepted', ({ change, accepted }) => {
    expect(
      UpdateSignInSettingsBodySchema.safeParse({ ...VALID, ...change }).success,
    ).toBe(accepted);
  });
});
