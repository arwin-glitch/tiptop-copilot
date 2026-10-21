import { cn } from '@/lib/util/cn';

/**
 * The small "AI" beside Ask Arwin's name, wherever the name is shown: the
 * panel's header, the full Ask page's title and the "Arwin replied" pop-up
 * (the launcher draws its own, on the button). The chatbot still calls
 * itself Arwin (D-059); this says, at a glance, that it is the assistant and
 * not the person.
 *
 * A screen reader hears it as part of the name it sits in, "Ask Arwin (AI)",
 * not as a stray "AI". Gold on whatever it sits on, in `--label-gold`, which
 * holds 4.5:1 on every ground in both themes.
 */
export function AiTag({ className }: { className?: string }) {
  return (
    <span
      data-ai-tag=""
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border border-[var(--gold)] px-1 align-middle font-sans text-[10px] leading-[15px] font-semibold tracking-[0.06em] text-[var(--label-gold)]',
        className,
      )}
    >
      <span aria-hidden="true">AI</span>
      <span className="sr-only">{' (AI)'}</span>
    </span>
  );
}
