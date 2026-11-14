import { z } from 'zod';
import { argsHash } from '../canonical-json.js';
import { defineTool } from './fixture-tool.js';

const NOTE_ID_LENGTH = 12;

const CreateIncidentNoteArgsSchema = z.strictObject({
  orderId: z.string().min(1).meta({ title: 'Заказ' }),
  text: z.string().min(1).meta({ title: 'Текст' }),
});

/**
 * The changing tool of the back office (listed without `readOnlyHint`). Nothing is stored: the note id is derived
 * from the arguments, so a repeated call is visible only in the call log.
 */
export const createIncidentNoteTool = defineTool({
  name: 'create_incident_note',
  title: 'Создать заметку по инциденту',
  description: 'Attach an incident note with the given text to a back-office order. Returns the created note.',
  readOnly: false,
  argsSchema: CreateIncidentNoteArgsSchema,
  run(args) {
    return { noteId: argsHash(args).slice(0, NOTE_ID_LENGTH), orderId: args.orderId, text: args.text };
  },
});
