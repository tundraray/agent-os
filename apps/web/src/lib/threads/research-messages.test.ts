import type { AppendMessage, RunConfig } from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  isHiddenMessageAt,
  isLastVisibleMessageAt,
  shouldResendTurn,
  toResearchCreateMessage,
  type FeedMessage,
} from './research-messages';

const user = (custom: Record<string, unknown> = {}): FeedMessage => ({ role: 'user', metadata: { custom } });
const assistant = (custom: Record<string, unknown> = {}): FeedMessage => ({ role: 'assistant', metadata: { custom } });

const DECISION = { researchDecision: { action: 'confirm', launchKey: 'call-1' } };
const DECISION_REPLY = { researchDecisionReply: { launchKey: 'call-1' } };
const ANSWER = { researchAnswer: { launchKey: 'call-1' } };

describe('Hidden decision pair (design-chat-entry DC-7; web-shell KD-2, Terms)', () => {
  it.each([
    { name: 'an ordinary exchange is shown', feed: [user(), assistant()], hidden: [false, false] },
    { name: 'a mode message is shown', feed: [user({ deepResearch: true }), assistant()], hidden: [false, false] },
    { name: 'the decision and its labelled reply are hidden', feed: [user(DECISION), assistant(DECISION_REPLY)], hidden: [true, true] },
    {
      name: 'an answer right after the pair is shown',
      feed: [user(DECISION), assistant(DECISION_REPLY), assistant(ANSWER)],
      hidden: [true, true, false],
    },
    {
      name: 'a decision without a reply is hidden alone, the answer right after it is shown',
      feed: [user(DECISION), assistant(ANSWER)],
      hidden: [true, false],
    },
    {
      name: 'a decision without a reply is hidden alone, the next exchange is shown',
      feed: [user(DECISION), user(), assistant()],
      hidden: [true, false, false],
    },
    {
      // assistant-ui joins consecutive assistant messages and merges their labels
      name: 'a reply carrying both the reply label and an answer is shown',
      feed: [user(DECISION), assistant({ ...DECISION_REPLY, ...ANSWER })],
      hidden: [true, false],
    },
  ])('$name', ({ feed, hidden }) => {
    expect(feed.map((_, index) => isHiddenMessageAt(feed, index))).toEqual(hidden);
  });

  it.each([
    { name: 'without pairs the last message is the last visible', feed: [user(), assistant()], last: [false, true] },
    {
      name: 'a pair after a reply leaves that reply the last visible',
      feed: [user(), assistant(), user(DECISION), assistant(DECISION_REPLY)],
      last: [false, true, false, false],
    },
    {
      name: 'a decision without a reply after a reply leaves that reply the last visible',
      feed: [user(), assistant(), user(DECISION)],
      last: [false, true, false],
    },
    {
      name: 'an answer after a pair is the last visible',
      feed: [user(), assistant(), user(DECISION), assistant(DECISION_REPLY), assistant(ANSWER)],
      last: [false, false, false, false, true],
    },
  ])('TH-10 last visible message: $name', ({ feed, last }) => {
    expect(feed.map((_, index) => isLastVisibleMessageAt(feed, index))).toEqual(last);
  });
});

const QUESTION: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Вопрос' }] };

const reply = (parts: UIMessage['parts']): UIMessage[] => [QUESTION, { id: 'a1', role: 'assistant', parts }];

describe('Resending a turn and the mode in the message metadata (design-chat-entry KD-1)', () => {
  it.each([
    {
      name: 'a turn that ended with a deepResearch call is not resent',
      messages: reply([
        { type: 'step-start' },
        { type: 'tool-deepResearch', toolCallId: 'call-1', state: 'output-available', input: { goal: 'Цель' }, output: {} },
      ]),
      resend: false,
    },
    {
      name: 'a turn that ended with a dynamic deepResearch call is not resent',
      messages: reply([
        { type: 'step-start' },
        {
          type: 'dynamic-tool',
          toolName: 'deepResearch',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { goal: 'Цель' },
          output: {},
        },
      ]),
      resend: false,
    },
    {
      name: 'a turn with a completed call of another tool is resent',
      messages: reply([
        { type: 'step-start' },
        { type: 'tool-search', toolCallId: 'call-2', state: 'output-available', input: { q: 'x' }, output: { ok: true } },
      ]),
      resend: true,
    },
    {
      name: 'a turn that ended with text is not resent',
      messages: reply([{ type: 'step-start' }, { type: 'text', text: 'Ответ', state: 'done' }]),
      resend: false,
    },
  ])('$name', ({ messages, resend }) => {
    expect(shouldResendTurn({ messages })).toBe(resend);
  });

  const composed = (runConfig: RunConfig): AppendMessage => ({
    role: 'user',
    content: [{ type: 'text', text: 'Вопрос' }],
    attachments: [],
    metadata: { custom: {} },
    createdAt: new Date('2026-11-02T10:00:00Z'),
    parentId: null,
    sourceId: null,
    runConfig,
  });

  it.each([
    {
      name: 'the mode on puts deepResearch into the metadata',
      runConfig: { custom: { deepResearch: true } },
      metadata: { custom: {}, deepResearch: true },
    },
    { name: 'the mode off leaves it out', runConfig: { custom: { deepResearch: false } }, metadata: { custom: {} } },
    { name: 'no run config leaves it out', runConfig: {}, metadata: { custom: {} } },
  ])('$name', ({ runConfig, metadata }) => {
    expect(toResearchCreateMessage(composed(runConfig))).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: 'Вопрос' }],
      metadata,
    });
  });
});
