'use client';

import type { EventQuestionPublic } from '@/lib/events/contracts';
import { DIETARY_NOTE_SUFFIX, DIETARY_OPTIONS } from '@/lib/events/questions';

/**
 * One registration question as a form field (D-075). Every label, option and
 * help text is rendered as React text — never HTML.
 */

export type AnswerMap = Record<string, string | string[] | boolean | number>;

export function QuestionField({
  question,
  idPrefix,
  answers,
  onChange,
  error,
  disabled,
}: {
  question: EventQuestionPublic;
  idPrefix: string;
  answers: AnswerMap;
  onChange: (key: string, value: string | string[] | boolean | number | undefined) => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = `${idPrefix}-${question.id}`;
  const value = answers[question.id];
  const helpId = question.help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const described = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const label = (
    <span className="evu-label" id={`${id}-label`}>
      {question.label}
      {question.required ? (
        <span className="evu-required" aria-hidden="true">
          *
        </span>
      ) : null}
    </span>
  );
  const common = {
    id,
    disabled,
    'aria-describedby': described,
    'aria-invalid': error ? true : undefined,
    'aria-required': question.required || undefined,
  };

  let control: React.ReactNode;
  switch (question.type) {
    case 'long_text':
      control = (
        <textarea
          {...common}
          className="evu-textarea"
          maxLength={2000}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(question.id, e.target.value)}
        />
      );
      break;
    case 'single_choice':
      control = (
        <select
          {...common}
          className="evu-select"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(question.id, e.target.value || undefined)}
        >
          <option value="">Choose…</option>
          {question.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'multi_choice':
    case 'dietary': {
      const options: readonly string[] =
        question.type === 'dietary' ? DIETARY_OPTIONS : question.options;
      const chosen = Array.isArray(value) ? value : [];
      control = (
        <div
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={described}
          className="evu-row"
        >
          {options.map((o) => {
            const checked = chosen.includes(o);
            return (
              <label key={o} className="evu-choice" data-checked={checked}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={checked}
                  onChange={() =>
                    onChange(question.id, checked ? chosen.filter((x) => x !== o) : [...chosen, o])
                  }
                />
                <span>{o}</span>
              </label>
            );
          })}
          {question.type === 'dietary' && chosen.includes('Other') ? (
            <input
              className="evu-input"
              aria-label="Tell us more"
              placeholder="Tell us more"
              maxLength={200}
              disabled={disabled}
              value={String(answers[`${question.id}${DIETARY_NOTE_SUFFIX}`] ?? '')}
              onChange={(e) => onChange(`${question.id}${DIETARY_NOTE_SUFFIX}`, e.target.value)}
            />
          ) : null}
        </div>
      );
      break;
    }
    case 'yes_no':
      control = (
        <div className="evu-seg" role="group" aria-labelledby={`${id}-label`}>
          {(['yes', 'no'] as const).map((v) => (
            <button
              key={v}
              type="button"
              disabled={disabled}
              aria-pressed={value === (v === 'yes')}
              onClick={() => onChange(question.id, v === 'yes')}
            >
              {v === 'yes' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      );
      break;
    case 'number':
      control = (
        <input
          {...common}
          className="evu-input"
          type="number"
          inputMode="decimal"
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          onChange={(e) =>
            onChange(question.id, e.target.value === '' ? undefined : e.target.value)
          }
        />
      );
      break;
    case 'terms':
      control = (
        <div className="evu-stack">
          {question.help ? (
            <details>
              <summary className="evu-btn-link">Read the terms</summary>
              <p className="evu-help" style={{ whiteSpace: 'pre-wrap' }}>
                {question.help}
              </p>
            </details>
          ) : null}
          <input
            {...common}
            className="evu-input"
            autoComplete="name"
            placeholder="Type your full name to agree"
            maxLength={120}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(question.id, e.target.value)}
          />
        </div>
      );
      break;
    default: {
      const type =
        question.type === 'url' || question.type === 'linkedin'
          ? 'url'
          : question.type === 'phone'
            ? 'tel'
            : 'text';
      const autoComplete =
        question.type === 'company'
          ? 'organization'
          : question.type === 'job_title'
            ? 'organization-title'
            : question.type === 'phone'
              ? 'tel'
              : question.type === 'url'
                ? 'url'
                : 'off';
      control = (
        <input
          {...common}
          className="evu-input"
          type={type}
          autoComplete={autoComplete}
          maxLength={question.type === 'phone' ? 40 : 500}
          placeholder={question.type === 'linkedin' ? 'https://linkedin.com/in/…' : undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(question.id, e.target.value)}
        />
      );
    }
  }

  return (
    <div>
      {question.type === 'multi_choice' ||
      question.type === 'dietary' ||
      question.type === 'yes_no' ? (
        label
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {control}
      {question.help && question.type !== 'terms' ? (
        <p className="evu-help" id={helpId}>
          {question.help}
        </p>
      ) : null}
      {error ? (
        <p className="evu-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
