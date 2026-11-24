import { render, screen, waitFor } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FieldErrors } from '@/lib/admin/form-rules';
import { AdminForm, AdminTextField } from './admin-form';

type Values = { login: string; name: string };

const rules = ({ login, name }: Values): FieldErrors<keyof Values> => ({
  ...(login === '' ? { login: 'loginRequired' as const } : {}),
  ...(name === '' ? { name: 'nameRequired' as const } : {}),
});

function renderForm(onSubmit: (values: Values) => Promise<void>): void {
  render(
    <AdminForm
      variant="page"
      initialValues={{ login: '', name: '' }}
      validate={rules}
      onSubmit={onSubmit}
      submitLabel="Сохранить"
      logEvent="admin: test form"
    >
      {(form) => (
        <>
          <AdminTextField
            {...form.field('login')}
            label="Логин"
            value={form.values.login}
            onChange={(value) => form.set('login', value)}
          />
          <AdminTextField
            {...form.field('name')}
            label="Имя"
            value={form.values.name}
            onChange={(value) => form.set('name', value)}
          />
        </>
      )}
    </AdminForm>,
  );
}

describe('AdminForm (KD-5, settings-form «Ошибка поля», «Сохраняем», «Сервер отказал»)', () => {
  it('a form with field errors sends nothing and focuses its first field with an error; while saving it is disabled and a second press sends nothing; a server refusal shows above the actions with the fields kept', async () => {
    let refuse: (error: Error) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const user = userEvent.setup();
    renderForm(onSubmit);
    const login = screen.getByLabelText('Логин');
    const name = screen.getByLabelText('Имя');

    // Field errors: nothing is sent, focus lands on the first field in order with an error.
    await user.type(name, 'Иван');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Введите логин')).toBeInTheDocument();
    expect(login).toHaveFocus();

    // Saving: one request, the fields and the button are disabled, a second press sends nothing.
    await user.type(login, 'ivan');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ login: 'ivan', name: 'Иван' });
    const saving = screen.getByRole('button', { name: 'Сохраняем…' });
    expect(saving).toBeDisabled();
    expect(login).toBeDisabled();
    await user.click(saving);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Server refusal: the form's error block above the actions takes focus, the typed values stay.
    refuse(new Error('Okta не ответила'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось сохранить: Okta не ответила');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(login).toHaveValue('ivan');
    expect(name).toHaveValue('Иван');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  });
});
