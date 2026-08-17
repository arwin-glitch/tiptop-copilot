# Paste this into the new chat

Everything below the line is the prompt. Copy it whole.

---

You are continuing work on **TipTop Copilot**, an internal AI operating system
for TipTop VC at `E:\tiptop-copilot`. It is built, tested and **live on real
data** — Nick's actual mailbox syncs into it. This session is about design.

## Read first

Read `E:\tiptop-copilot\DESIGN_HANDOVER.md` before running or changing
anything. It is current and accurate, and its §6 matters most: **the brief
below names several features that do not exist in this codebase**, and taking
it at face value will send you looking for things that were never built.

Confirm the current state yourself — `npm run verify` and `npm run test:e2e` —
rather than taking my word for it.

## Environment

Node is not installed system-wide. Prefix every command:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

Windows PowerShell 5.1 — no `&&`, no `??`, no ternary. Python unavailable.
Never write outside `E:\tiptop-copilot`.

**Next.js 16**: `middleware` is `proxy` (`src/proxy.ts`), and
`cookies()`/`headers()`/`params`/`searchParams` are async. Version-matched docs
are in `node_modules/next/dist/docs/`. Do not "correct" these to Next 15.

## The brief

One additional requirement: the TipTop Co-pilot must not only outperform Cura
functionally—it should also look and feel substantially better than Cura and
other portfolio-management products.

Treat visual design and user experience as core product requirements, not
final-stage polish.

Create a distinctive, premium interface that feels like a purpose-built
intelligence operating system for a modern venture fund. Avoid a generic admin
dashboard, basic component-library appearance, excessive boxed cards, crowded
tables, random gradients, and obvious "AI-generated app" styling.

Design direction:

- Sophisticated, modern, confident, and highly polished
- Information-dense without feeling cluttered
- Clear hierarchy that immediately directs attention to what matters
- Editorial-quality typography and spacing
- Refined use of color, contrast, borders, shadows, and depth
- Consistent light and dark themes
- TipTop-specific visual identity rather than a copied SaaS template
- Professional enough for investors, but still energetic and memorable

Improve the experience across the entire product:

1. Create or refine a coherent design system covering typography, color tokens,
   spacing, grids, surfaces, buttons, forms, tables, badges, charts,
   navigation, dialogs, and interaction states.
2. Design a polished application shell with excellent navigation, contextual
   page titles, global search, shortcuts, account controls, and responsive
   behavior.
3. Make the portfolio intelligence feed visually scannable. Important signals,
   risks, opportunities, sources, confidence, and event types should be
   understandable at a glance without overwhelming the user.
4. Give each portfolio company a premium company page with a strong header, key
   metrics, recent signals, timeline, hiring activity, contacts, tasks,
   documents, and source health.
5. Make the intelligence dashboard feel alive and useful through thoughtfully
   designed charts, trends, comparisons, status indicators, and compact data
   visualizations. Do not add decorative charts that do not help decisions.
6. Present dense deal and portfolio tables with excellent alignment, hierarchy,
   filtering, saved views, sorting, column controls, sticky headers, and useful
   row interactions.
7. Add polished loading, empty, error, offline, disabled, success, and "not
   configured" states. Empty states should explain the next useful action
   instead of leaving blank screens.
8. Use restrained motion and micro-interactions for navigation, filtering,
   saving, expanding details, and newly arriving information. Animations should
   feel fast and purposeful, never distracting.
9. Make the interface excellent on desktop, tablet, and mobile. Do not simply
   compress the desktop layout onto smaller screens.
10. Meet WCAG AA accessibility standards, support keyboard navigation, preserve
    visible focus states, respect reduced-motion preferences, and use semantic
    markup.
11. Optimize perceived performance with skeleton states, progressive rendering,
    optimistic interactions where safe, and minimal layout shift.

Before implementing the visual changes:

- Audit the current UI for inconsistency, clutter, weak hierarchy, and generic
  styling.
- Establish the design language and reusable primitives first.
- Identify the highest-impact screens and interactions.
- Preserve all working functionality, permissions, safety rules, and tests.
- Use the existing stack and component system where appropriate, but customize
  it enough to produce a recognizable TipTop product.
- Do not clone another product, but study the interaction quality expected from
  best-in-class modern productivity, intelligence, and financial software.

Implement the visual system through real application screens—not just a
concept, mockup, or isolated style guide. Begin with the application shell,
intelligence dashboard, portfolio feed, company detail page, and public job
board, then propagate the system consistently throughout the rest of the app.

The final result should pass this test: if someone sees the product without its
logo, it should still feel intentional, premium, cohesive, and clearly more
thoughtfully designed than Cura or a standard SaaS dashboard.

## What I need you to tell me before you start

The brief above is what I want. The handover says some of it does not exist
yet. So before writing any code:

1. **Split the brief into "restyle what exists" and "build something new."**
   §6 of the handover has my predecessor's audit — verify it rather than trust
   it. I believe there are no charts anywhere and no job board at all.
2. **Tell me what each half costs** in rough time, and propose an order.
3. **Tell me what you would do first** if I only had a few days.

Then wait for me to choose. Do not start with the job board because it is
listed in the brief.

## Constraints that are not negotiable

- **The 13 invariants in the handover §3.** Several are database constraints.
  If a design seems to require breaking one, stop and ask.
- **The AI is currently switched off.** There is no `ANTHROPIC_API_KEY`, so
  every AI-derived surface renders a "not configured" state right now. Those
  are not edge cases to style last — they are the *primary* state of `/today`,
  `/ask` and every scorecard today. Design for a product whose intelligence
  layer may stay off.
- **The brand is already applied.** Palette and mark come from TipTop's own
  brand guide. Refine, do not replace. `#0FC382` must never be text on a light
  background — it fails contrast at 2.2:1.
- **Keep the suites green.** 473 unit and integration tests, 38 Playwright
  tests including an accessibility suite that asserts one `h1` per page, a
  visible skip link, labelled controls, an announced status region and keyboard
  operability. If a redesign breaks those, the redesign is wrong.
- Do not send email. Do not spend money without telling me the amount first.
  Never commit a secret — the repo is public.

## Reporting

Do not claim a screen works because it compiles. Run it. At the end, tell me
what changed, what you verified and how, and what you left alone.
