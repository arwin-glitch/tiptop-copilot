'use client';

import * as React from 'react';
import { THEME_PRESETS } from '@/lib/events/themes';
import { orderedSections, type ThemeKey } from '@/lib/events/schema';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { useStudio, type Device } from './studio-context';

interface Command {
  id: string;
  group: string;
  label: string;
  run: () => void;
}

/** Cmd/Ctrl+K: jump to a section, switch theme, toggle device, and Studio's other actions. */
export function CommandPalette() {
  const studio = useStudio();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);

  React.useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setQuery('');
      setActive(0);
    };
    window.addEventListener('studio:palette', onOpen);
    return () => window.removeEventListener('studio:palette', onOpen);
  }, []);

  const commands: Command[] = [
    ...orderedSections(studio.doc.sections).map((s) => ({
      id: `section-${s.id}`,
      group: 'Go to',
      label: studio.labelOf(s),
      run: () => {
        studio.select(s.id);
        document
          .querySelector(`[data-studio-frame] [data-section-id="${s.id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    })),
    ...(studio.structureDenied()
      ? []
      : [
          {
            id: 'add',
            group: 'Do',
            label: 'Add a section',
            run: () => studio.openGallery(studio.selectedId),
          },
        ]),
    {
      id: 'preview',
      group: 'Do',
      label: 'Full-screen preview',
      run: () => studio.setFullPreview(true),
    },
    { id: 'undo', group: 'Do', label: 'Undo', run: () => studio.editor.undo() },
    { id: 'redo', group: 'Do', label: 'Redo', run: () => studio.editor.redo() },
    { id: 'save', group: 'Do', label: 'Save now', run: () => void studio.session.flush() },
    ...(['desktop', 'tablet', 'phone', 'fit'] as Device[]).map((d) => ({
      id: `device-${d}`,
      group: 'Device',
      label: `Show on ${d === 'fit' ? 'the full window' : d}`,
      run: () => studio.setDevice(d),
    })),
    ...(studio.themeDenied('background')
      ? []
      : THEME_PRESETS.map((p) => ({
          id: `theme-${p.id}`,
          group: 'Theme',
          label: `Theme: ${p.name}`,
          run: () => {
            const set: Partial<Record<ThemeKey, unknown>> = {};
            for (const key of Object.keys(p.theme) as ThemeKey[]) {
              if (key !== 'brand' && !studio.themeDenied(key))
                set[key] = structuredClone(p.theme[key as keyof typeof p.theme]);
            }
            studio.updateTheme(set, `Theme: ${p.name}`);
          },
        }))),
  ];
  const q = query.trim().toLowerCase();
  const shown = q
    ? commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q))
    : commands;

  function run(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    command.run();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <DialogContent
          title="Command palette"
          description="Type to find a section, a theme or an action."
        >
          <label className="sr-only" htmlFor="studio-command">
            Command
          </label>
          <Input
            id="studio-command"
            autoFocus
            value={query}
            placeholder="Jump to, theme, device…"
            role="combobox"
            aria-expanded="true"
            aria-controls="studio-command-list"
            aria-activedescendant={shown[active] ? `cmd-${shown[active]!.id}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(shown.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[active]);
              }
            }}
          />
          <ul id="studio-command-list" role="listbox" className="mt-2 max-h-72 overflow-y-auto">
            {shown.map((c, i) => (
              <li
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                className={
                  i === active
                    ? 'flex cursor-pointer justify-between rounded-md bg-[var(--bg-hover)] px-2 py-1.5 text-sm'
                    : 'flex cursor-pointer justify-between rounded-md px-2 py-1.5 text-sm'
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span>{c.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">{c.group}</span>
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-[var(--fg-muted)]">No matches.</li>
            ) : null}
          </ul>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
