# Paste this into the new chat

Everything below the line is the prompt. Copy it whole.

---

I want to build a Claude Code **skill** plus a **scheduled routine** that gives
me the useful parts of an internal app I've already built, without running the
app.

## Read first

Read `E:\tiptop-copilot\SKILL_HANDOVER.md` before proposing or building
anything. It is current and accurate. It tells you what to reuse from the
existing app, what is genuinely weaker about doing this as a skill, and the
constraints that decide the design.

The app itself is at `E:\tiptop-copilot`. It is finished, verified and
deployed. **Read it freely; do not modify its source.**

## What I want

1. **Ask it anything** — "what's waiting on me", "what did that co-investor say
   about Vetrix", "summarise the newest inbound" — answered from real mail and
   calendar, on demand.
2. **A daily outlook, pushed to me** — what's overdue, what's waiting on a
   reply, today's meetings and what to bring to each, new inbound, portfolio
   asks, LP items. The app's `/today` screen is the shape that works; copy it.
3. **Deals surfaced from email** — new inbound spotted, classified and
   summarised, with no database behind it.

## Why a skill and not the app

The app needs a paid Anthropic API key to be intelligent. A skill runs on the
Claude subscription I already pay for. **That is the whole point.** If your
design reintroduces a per-token API key, you have missed it — tell me rather
than building it.

## The mailbox

I have a connector connected to **Nick's** account. This assistant is for his
mail and calendar, not mine.

**Verify that once before building on it** — read the connected profile or list
a couple of threads and confirm the account that comes back is actually his. If
it silently resolves to my account instead, everything downstream would look
plausible and be about the wrong person.

This is real correspondence, not test data.

## Environment

Node is not installed system-wide. Prefix commands with:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

Shell is Windows PowerShell 5.1 — no `&&`, no `??`, no ternary. Python is
unavailable. `E:\` is my personal drive root with ~200 unrelated files — never
write to it directly.

`E:\tiptop-copilot` has a **public** GitHub remote. Nothing real and no keys
in a commit.

## What to reuse

The valuable thing in that repo is the judgement, not the code. `AI_PROMPTS.md`
§3 is a block called `CORE_RULES` — tone, untrusted content, grounding,
authority limits. Lift it near-verbatim into the skill. It is what stops this
confidently inventing things, which matters because a fund will act on what it
says.

Read `ARCHITECTURE.md` on how the daily outlook is assembled: candidates
gathered from records first, the model used only to narrow and phrase them.
Keep that order.

## Be straight with me about the downgrades

The handover §3 lists four things that get worse as a skill. I want you to
tell me about them in your own words rather than skipping past them —
particularly that the app physically could not send email, and a skill with a
mail connector can. Don't sell me this as strictly better than the app.

## Rules

- Do not modify the app's source in `E:\tiptop-copilot\src`.
- **Do not send email.** Draft only, and only ever after I confirm that
  specific message in chat.
- Do not spend money. If the design needs a paid key, it's the wrong design.
- Do not put real data or keys in that public repo.
- Don't claim something works unless you ran it and saw it work.

## What to do first

Don't start building. Report back with:

1. That the connector resolves to Nick's account, and how you confirmed it.
2. Which connectors and scheduling mechanisms actually exist in this session —
   verify, don't assume.
3. What this skill will and won't be able to guarantee.

Then propose the shape and wait for me.
