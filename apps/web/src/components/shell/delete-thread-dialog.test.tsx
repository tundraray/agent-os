import type { ResearchLaunchView } from '@agent-os/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchLaunchView, threadResearch } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { DeleteThreadDialog } from './delete-thread-dialog';

const A4_TEXT = 'Ответ ассистента в этой беседе ещё генерируется — он будет остановлен.';

const THREAD_ID = 't-1';
const RESEARCH_URL = `http://api.test/api/threads/${THREAD_ID}/research`;

type HarnessProps = {
  isRunning?: boolean;
  onConfirm?: () => void;
};

/** Every open of the dialog reads the thread's launches: by default the thread has none. */
function serveResearch(reply: () => Response = () => HttpResponse.json(threadResearch([]))): {
  reads: () => number;
  answered: () => number;
} {
  let reads = 0;
  let answered = 0;
  server.use(
    http.get(RESEARCH_URL, async () => {
      reads += 1;
      const response = await Promise.resolve(reply());
      answered += 1;
      return response;
    }),
  );
  return { reads: () => reads, answered: () => answered };
}

beforeEach(() => {
  serveResearch();
});

/** The dialog opened from a «⋯» button that is its final-focus target, as the thread list renders it. */
function Harness({ isRunning = false, onConfirm = vi.fn() }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={actionsRef} type="button" onClick={() => setOpen(true)}>
        Действия с беседой «Отчёт Q3»
      </button>
      <DeleteThreadDialog
        open={open}
        threadTitle="Отчёт Q3"
        threadId={THREAD_ID}
        isRunning={isRunning}
        onConfirm={onConfirm}
        onOpenChange={setOpen}
        finalFocus={actionsRef}
      />
    </>
  );
}

async function openDialog(props: HarnessProps = {}) {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await user.click(screen.getByRole('button', { name: 'Действия с беседой «Отчёт Q3»' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Удалить беседу?' });
  return { user, dialog };
}

describe('DeleteThreadDialog — DLG-01 (AC-06.1, A-4)', () => {
  it('is an alertdialog «Удалить беседу?» naming the thread in «ёлочки», with focus on «Отмена»', async () => {
    const { dialog } = await openDialog();

    expect(dialog).toHaveAccessibleDescription(
      'Беседа «Отчёт Q3» и все её сообщения будут удалены. Это действие нельзя отменить.',
    );
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Отмена', 'Удалить']);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus());
    expect(within(dialog).queryByText(A4_TEXT)).toBeNull();
  });

  it('A-4: while a reply is generating the dialog adds that it will be stopped', async () => {
    const { dialog } = await openDialog({ isRunning: true });

    expect(within(dialog).getByText(A4_TEXT)).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(A4_TEXT));
  });

  it('«Удалить» confirms once and closes the dialog at once', async () => {
    const onConfirm = vi.fn<() => void>();
    const { user, dialog } = await openDialog({ onConfirm });

    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('«Отмена» closes without confirming and returns focus to «⋯»', async () => {
    const onConfirm = vi.fn<() => void>();
    const { user, dialog } = await openDialog({ onConfirm });

    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Действия с беседой «Отчёт Q3»' })).toHaveFocus());
  });
});

describe('DeleteThreadDialog — MC-22 for running research (deep-research DC-6, AC-22.1)', () => {
  const MC_22_ONE = 'В беседе идёт ресерч — он будет остановлен, ответа не будет.';
  const MC_22_SEVERAL = 'В беседе идут ресерчи — они будут остановлены, ответов не будет.';

  const launch = (launchKey: string, overrides: Partial<ResearchLaunchView>): ResearchLaunchView =>
    researchLaunchView({ launchKey, ...overrides });
  const running = (launchKey: string) => launch(launchKey, { state: 'running' });
  const settled: ResearchLaunchView[] = [
    launch('call-p', { mode: 'proposal', state: 'proposed' }),
    launch('call-c', { state: 'completed', answerMessageId: 'research-answer-inv-c' }),
    launch('call-a', { state: 'completed', answerPending: true }),
    launch('call-f', { state: 'failed' }),
    launch('call-s', { state: 'stopped' }),
    launch('call-n', { mode: 'proposal', state: 'not_launched', notLaunchedReason: 'declined' }),
  ];

  // The rule: the paragraph counts the launches in `running` only — singular for one, plural for several, none otherwise.
  it.each<{ name: string; launches: ResearchLaunchView[]; text: string | null }>([
    { name: 'one running launch among settled ones', launches: [...settled, running('call-1')], text: MC_22_ONE },
    { name: 'two running launches', launches: [running('call-1'), running('call-2')], text: MC_22_SEVERAL },
    { name: 'no running launch', launches: settled, text: null },
    { name: 'no launch at all', launches: [], text: null },
  ])('$name: MC-22 is $text', async ({ launches, text }) => {
    const traffic = serveResearch(() => HttpResponse.json(threadResearch(launches)));
    const { dialog } = await openDialog();

    await waitFor(() => expect(traffic.reads()).toBe(1));
    if (text === null) {
      // The read has been answered; let the dialog take it before asserting the absence.
      await waitFor(() => expect(traffic.answered()).toBe(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(within(dialog).queryByText(/ресерч/)).toBeNull();
      expect(dialog).toHaveAccessibleDescription(
        'Беседа «Отчёт Q3» и все её сообщения будут удалены. Это действие нельзя отменить.',
      );
    } else {
      expect(await within(dialog).findByText(text)).toBeVisible();
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining(text));
      expect(within(dialog).queryByText(text === MC_22_ONE ? MC_22_SEVERAL : MC_22_ONE)).toBeNull();
    }
  });

  it('a failed read shows no MC-22 and leaves the dialog working', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const traffic = serveResearch(() => new HttpResponse(null, { status: 500 }));
    const onConfirm = vi.fn<() => void>();
    const { user, dialog } = await openDialog({ onConfirm });

    await waitFor(() => expect(traffic.reads()).toBe(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(within(dialog).queryByText(/ресерч/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
