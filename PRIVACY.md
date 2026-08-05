# Privacy notice

TipTop Copilot is an internal tool for TipTop VC. This describes what it stores,
what it sends where, and how to remove it.

This document mirrors the in-app notice at `/privacy`. **If you change one,
change both** — the in-app page is what a founder or LP would be shown, and a
divergence between them is a straightforward misrepresentation.

---

## What is stored

Email **metadata** — sender, recipients, subject, date, labels, thread, snippet
— for messages in the configured lookback window.

Full message **bodies and attachments** are stored only after a specific
trigger:

- you open the message, or
- the classifier judges it consequential (a deal, a portfolio update, an LP item
  or substantive founder correspondence), or
- automatic deep analysis has been switched on in configuration
  (`DEEP_AUTO_ANALYSIS`, off by default).

Calendar events for the days shown in the outlook.

Deals, notes, decisions, tasks, drafts and uploaded documents that you create.

Estimated AI usage per request, and an audit record of every consequential
action.

---

## What is not stored

- Your Google password. The product never sees it.
- Message bodies for mail that was never opened or flagged.
- Anything from mailboxes or calendars you have not connected.
- Provider tokens in plaintext.
- Raw client IP addresses. Audit records store a one-way hash.

---

## Where data goes

Data stays in your Supabase project except when a request needs a model. In that
case the relevant excerpts — the email, attachment text or document passages
needed for **that specific request** — are sent to Anthropic's API from the
server. Your API key never reaches the browser.

Public web research is off unless configured. When it is on, only the search
query is sent to the research provider, never your private content, and results
are labelled as public-web with their publication and retrieval dates.

There are no analytics, no third-party trackers and no telemetry.

---

## Google access

Read-only. The product requests exactly three scopes:

```
gmail.readonly · calendar.readonly · userinfo.email
```

It does **not** request permission to send email, and it has no send capability.
Replies are produced as drafts for you to send yourself from your own client.

Refresh tokens are encrypted with AES-256-GCM using a key held only in the
server environment, bound to the specific integration record, and never written
to logs.

---

## Attachments and documents

Stored in a private bucket with no public path. Access is granted per request
through a signed URL that expires after fifteen minutes, and only after an
authorization check.

Filenames are sanitised and file types are verified by content, not by the
declared header. Parsing happens locally — nothing is sent to a third-party
conversion service.

---

## AI and your data

Every AI-generated surface is labelled and records the model, the prompt version
and the sources it used.

Content from email, attachments, documents and the web is treated as **untrusted
data**. Instructions found inside it are never followed, and attempts are
flagged to you rather than hidden — a flagged message stays fully visible in your
inbox with an explanation of what was attempted.

The assistant recommends; it does not decide. It cannot mark a deal invested,
send a message, or take a financial action.

---

## Removing data

**Settings** offers two separate actions:

- **Disconnect Google** — revokes access at Google (best effort) and deletes the
  stored tokens locally, always, whether or not Google responded. Synced mail is
  left alone.
- **Delete my data** — removes every synced message, thread and attachment for
  the organization and resets the sync cursor. Deals, portfolio, knowledge and
  tasks are untouched.

Deleting the Supabase project removes everything else.

---

## Retention

There is no automatic deletion. Data persists until you remove it or delete the
project. Sessions expire after twelve hours.

---

## Scope

This is an internal tool operated by TipTop VC for its own team. It is not a
public service and collects nothing from anyone who is not a signed-in member of
the organization.

People who appear in the data — founders, LPs, portfolio contacts — are there
because they corresponded with the fund. Handle that data the way the fund
handles any other correspondence: it is not the product's job to make that
judgement for you, but it is worth stating that connecting a mailbox brings
other people's words into this system.
