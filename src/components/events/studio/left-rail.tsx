'use client';

import { Image as ImageIcon, Layers, Palette, Sparkles, Type } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { BrandPanel } from './brand-panel';
import { EffectsPanel } from './effects-panel';
import { MediaPanel } from './media-panel';
import { SectionOutline } from './section-outline';
import { useStudio, type RailTab } from './studio-context';
import { ThemePanel } from './theme-panel';

const TABS: { id: RailTab; label: string; icon: React.ReactNode }[] = [
  { id: 'sections', label: 'Sections', icon: <Layers aria-hidden="true" className="size-4" /> },
  { id: 'theme', label: 'Theme', icon: <Palette aria-hidden="true" className="size-4" /> },
  { id: 'brand', label: 'Brand', icon: <Type aria-hidden="true" className="size-4" /> },
  { id: 'effects', label: 'Effects', icon: <Sparkles aria-hidden="true" className="size-4" /> },
  { id: 'media', label: 'Media', icon: <ImageIcon aria-hidden="true" className="size-4" /> },
];

/** The left rail: the outline, then the page-wide design panels. */
export function LeftRail({ onPick }: { onPick: () => void }) {
  const { railTab, setRailTab } = useStudio();
  return (
    <>
      <div
        role="tablist"
        aria-label="Studio panels"
        className="grid shrink-0 grid-cols-5 border-b border-[var(--border)]"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            id={`rail-tab-${tab.id}`}
            aria-selected={railTab === tab.id}
            aria-controls={`rail-panel-${tab.id}`}
            onClick={() => setRailTab(tab.id)}
            className={cn(
              'flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
              railTab === tab.id
                ? 'border-b-2 border-[var(--primary)] text-[var(--fg)]'
                : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`rail-panel-${railTab}`}
        aria-labelledby={`rail-tab-${railTab}`}
        className="min-h-0 flex-1 scrollbar-thin overflow-y-auto"
      >
        {railTab === 'sections' ? <SectionOutline onPick={onPick} /> : null}
        {railTab === 'theme' ? <ThemePanel /> : null}
        {railTab === 'brand' ? <BrandPanel /> : null}
        {railTab === 'effects' ? <EffectsPanel /> : null}
        {railTab === 'media' ? <MediaPanel /> : null}
      </div>
    </>
  );
}
