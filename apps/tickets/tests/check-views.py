#!/usr/bin/env python3
"""Materialize later UI states (sheet, dialog, menus, drag, table, light mode) with `gpui-shell check`."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

APP = Path(__file__).resolve().parents[1]
cache = Path.home() / '.cache/gpui-shell-benchs-test-tmp'
cache.mkdir(parents=True, exist_ok=True)
source = (APP / 'main.js').read_text()
# Never read or write the user's saved tickets.
source = source.replace('const storageKey = "tickets.state.v1";', 'const storageKey = "tickets.check.fixture";')
anchor = '    // SLA states and relative times follow the clock.'
assert anchor in source
states = {
    'sheet': 'this.openNumber = 3;',
    'sheet-closed-ticket': 'this.openNumber = 7;',
    'dialog': 'this.openDraft("pending", cx); this.draft.error = "Give the ticket a subject.";',
    'table-light': 'this.layout = "table"; this.mode = "light"; applyTheme("light"); this.tableSort = { key: "priority", dir: -1 };',
    'filters-empty': 'this.view = "unassigned"; this.category = "billing"; this.priority = "urgent"; this.query = "zzz";',
    'menu-search': 'this.menu = "search";',
    'menu-notify': 'this.menu = "notify";',
    'menu-messages': 'this.menu = "messages";',
    'menu-profile': 'this.menu = "profile";',
    'menu-statuses': 'this.menu = "statuses"; this.shownStatuses = new Set(["open", "pending"]);',
    'menu-column': 'this.menu = "column-open"; this.columnSort.open = "priority";',
    'dragging': 'this.drag = { number: 1, x: 400, y: 500 }; this.dropStatus = "pending";',
    'placeholder-page': 'this.page = "reports"; this.notice = "Demo data restored";',
    'collapsed': 'this.sidebarOpen = false; this.statsOpen = false;',
    'sheet-wide-menus': 'this.openNumber = 1; this.sheetWide = true; this.menu = "sheet-send-more";',
    'sheet-type-menu': 'this.openNumber = 2; this.menu = "sheet-type";',
    'sheet-templates': 'this.openNumber = 2; this.menu = "sheet-templates";',
    'notify-unread': 'this.menu = "notify"; this.noticeTab = "unread";',
    'notify-empty': 'this.menu = "notify"; this.noticeTab = "unread"; for (const n of this.notices) n.read = true;',
    'inbox': 'this.page = "inbox";',
    'inbox-snoozed-menu': 'this.page = "inbox"; this.inboxView = "snoozed"; this.menu = "inbox-snooze"; this.inboxSearchOpen = true;',
    'inbox-empty': 'this.page = "inbox"; this.inboxView = "unassigned"; this.inboxUnreadOnly = true; this.inboxQuery = "zzz";',
    'inbox-from-menu': 'this.page = "inbox"; this.inboxView = "open"; this.menu = "inbox-from"; this.via = "chat";',
    'customers': 'this.page = "customers"; this.custSelected.add("polar-banking");',
    'customers-grid': 'this.page = "customers"; this.custLayout = "grid"; this.custView = "risk"; this.menu = "customers-columns";',
    'customers-empty-light': 'this.page = "customers"; this.custQuery = "zzz"; this.mode = "light"; applyTheme("light");',
    'customer-sheet': 'this.page = "customers"; this.custOpen = "acme-corp";',
    'customer-dialog': 'this.page = "customers"; this.openCustomerDraft(cx); this.custDraft.error = "Enter a valid email address.";',
}
with tempfile.TemporaryDirectory(prefix='tickets-views-', dir=cache) as scratch:
    for name, state in states.items():
        target = Path(scratch) / name
        shutil.copytree(APP, target, ignore=shutil.ignore_patterns('tests', 'gpui-kit.d.ts', 'jsconfig.json'))
        (target / 'main.js').write_text(source.replace(anchor, '    ' + state + '\n' + anchor, 1))
        manifest = json.loads((target / 'gpui-shell.json').read_text())
        manifest['id'] = 'com.huacnlee.tickets.check-' + name
        (target / 'gpui-shell.json').write_text(json.dumps(manifest))
        subprocess.run(['gpui-shell', 'check', '-d', str(target)], check=True)
        print('materialized:', name)
