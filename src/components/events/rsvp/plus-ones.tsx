'use client';

import type { EventQuestionPublic, EventRegistrationPublic } from '@/lib/events/contracts';
import { QuestionField, type AnswerMap } from './question-field';
import { askedQuestions } from './rsvp-shared';

/**
 * "Bringing a guest?" (D-075): named plus-ones, each with an optional email
 * (when the host collects it), the sessions they come to (when plus-ones are
 * per session) and their own answers to the questions the host asks them.
 */

export interface PlusOneDraft {
  key: string;
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  sessionIds: string[];
  answers: AnswerMap;
}

let counter = 0;
export function newPlusOne(sessionIds: string[]): PlusOneDraft {
  counter += 1;
  return { key: `po-${counter}`, firstName: '', lastName: '', email: '', sessionIds, answers: {} };
}

export function PlusOnes({
  registration,
  sessions,
  value,
  onChange,
  errors,
  disabled,
}: {
  registration: EventRegistrationPublic;
  /** Sessions the guest is coming to (the plus-one can come to these). */
  sessions: { id: string; name: string }[];
  value: PlusOneDraft[];
  onChange: (next: PlusOneDraft[]) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const max = registration.plusOnes.max;
  if (max <= 0 || !sessions.length) return null;
  const perSession = registration.plusOnes.perSession && sessions.length > 1;
  const update = (key: string, patch: Partial<PlusOneDraft>) =>
    onChange(value.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const questionsFor = (p: PlusOneDraft): EventQuestionPublic[] =>
    registration.plusOnes.askQuestions
      ? askedQuestions(registration.questions, p.sessionIds, p.answers, true)
      : [];

  return (
    <fieldset className="evu-stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="evu-label">
        Bringing a guest?{' '}
        <span className="evu-muted evu-small">
          (up to {max}
          {perSession ? ' per session' : ''})
        </span>
      </legend>
      {value.map((p, i) => (
        <div key={p.key} className="evu-card evu-stack" data-plus-one>
          <div className="evu-row" style={{ justifyContent: 'space-between' }}>
            <strong>Guest {i + 1}</strong>
            <button
              type="button"
              className="evu-btn-link"
              disabled={disabled}
              onClick={() => onChange(value.filter((x) => x.key !== p.key))}
            >
              Remove
            </button>
          </div>
          <div className="evu-grid2">
            <div>
              <label className="evu-label" htmlFor={`${p.key}-first`}>
                First name
                <span className="evu-required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id={`${p.key}-first`}
                className="evu-input"
                autoComplete="off"
                maxLength={100}
                required
                disabled={disabled}
                value={p.firstName}
                aria-invalid={errors[`${p.key}:firstName`] ? true : undefined}
                onChange={(e) => update(p.key, { firstName: e.target.value })}
              />
              {errors[`${p.key}:firstName`] ? (
                <p className="evu-error">{errors[`${p.key}:firstName`]}</p>
              ) : null}
            </div>
            <div>
              <label className="evu-label" htmlFor={`${p.key}-last`}>
                Last name
              </label>
              <input
                id={`${p.key}-last`}
                className="evu-input"
                autoComplete="off"
                maxLength={100}
                disabled={disabled}
                value={p.lastName}
                onChange={(e) => update(p.key, { lastName: e.target.value })}
              />
            </div>
          </div>
          {registration.plusOnes.collectEmail ? (
            <div>
              <label className="evu-label" htmlFor={`${p.key}-email`}>
                Their email <span className="evu-muted evu-small">(optional)</span>
              </label>
              <input
                id={`${p.key}-email`}
                className="evu-input"
                type="email"
                autoComplete="off"
                maxLength={320}
                disabled={disabled}
                value={p.email}
                onChange={(e) => update(p.key, { email: e.target.value })}
              />
            </div>
          ) : null}
          {perSession ? (
            <div role="group" aria-label={`Sessions for guest ${i + 1}`} className="evu-row">
              {sessions.map((s) => {
                const checked = p.sessionIds.includes(s.id);
                return (
                  <label key={s.id} className="evu-choice" data-checked={checked}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={checked}
                      onChange={() =>
                        update(p.key, {
                          sessionIds: checked
                            ? p.sessionIds.filter((x) => x !== s.id)
                            : [...p.sessionIds, s.id],
                        })
                      }
                    />
                    <span>{s.name}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {questionsFor(p).map((q) => (
            <QuestionField
              key={q.id}
              question={q}
              idPrefix={p.key}
              answers={p.answers}
              disabled={disabled}
              error={errors[`${p.key}:${q.id}`]}
              onChange={(k, v) => {
                const answers = { ...p.answers };
                if (v === undefined) delete answers[k];
                else answers[k] = v;
                update(p.key, { answers });
              }}
            />
          ))}
        </div>
      ))}
      {value.length < max ? (
        <button
          type="button"
          className="evu-btn evu-btn-secondary"
          disabled={disabled}
          onClick={() => onChange([...value, newPlusOne(sessions.map((s) => s.id))])}
        >
          + Add a guest
        </button>
      ) : null}
    </fieldset>
  );
}
