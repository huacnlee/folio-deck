# Tickets (gpui-shell demo)

A helpdesk built from a set of dark-theme design shots — a ticket board, an
inbox, a customer table, a notification panel and a ticket detail panel —
written in JavaScript and rendered natively by GPUI. No DOM, no browser. All
people, companies and tickets are made up.

This is referenced from: https://gray-ui-csm.vercel.app

<img width="1487" height="935" alt="image" src="https://github.com/user-attachments/assets/296304cd-c0d8-464b-8ceb-36d8bf2630dd" />

## What it does

- **Tickets** — summary tiles with week-over-week change, a four-column
  board (Open / Pending / Resolved / Closed) with drag-and-drop between
  columns, per-column sorting, a sortable table view, search, sidebar views
  (mine, unassigned, past due, escalated), category and priority filters, a
  status filter, CSV export to the clipboard and a new-ticket form (⌘N).
- **Ticket panel** — rename the ticket, set priority, type, status and
  assignee, reply or leave an internal note from a chosen inbox with canned
  templates, send and resolve in one step, expand to full width, follow the
  activity history.
- **Inbox** — active tickets as conversations, unread markers, my inbox /
  unassigned / all open / snoozed, unread-only filter and search, assign to
  me, snooze, resolve, reply by email or chat.
- **Customers** — 19 accounts with health, lifecycle, segment and owner;
  views and filters, risk-first sorting, column options, table or card
  layout, multi-select with bulk actions, an account panel with its tickets,
  and a new-customer form.
- **Notifications** — mentions, SLA breaches, replies, assignments and
  automation failures, grouped by day with an unread tab. The SLA monitor adds
  a notice whenever an open ticket passes its due time.
- SLA states follow the clock, light and dark themes, and everything persists
  with `localStorage`. *Reset demo data* in the profile menu restores the seed.

## Run

Requires `gpui-shell` 0.7.3 or later.

```bash
gpui-shell types -d .         # generate gpui-kit.d.ts for editor type checking
gpui-shell check -d .         # load and render once
gpui-shell run -d . --watch   # run, reloading on save
```

## Test

```bash
node --test tests/data.test.mjs   # seed counts, SLA, CSV
python3 tests/check-views.py      # materialize 28 later UI states with gpui-shell check
```

## Layout

```text
main.js       application view: rail, header, tickets page, board, table, ticket form, notifications
sheet.js      ticket detail panel, plus the activity rows and composer the inbox shares
inbox.js      inbox page
customers.js  customers page, account panel and form
data.js       seed tickets, customers and notifications; SLA, formatting and CSV
theme.js      dark and light palettes
ui.js         shared builders: icons, avatars, pills, buttons, menus, form controls
tickets/      SVG icons
```
