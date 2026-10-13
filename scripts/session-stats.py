#!/usr/bin/env python3
"""Summarise the time and tokens an AI coding session spent.

Reads Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl,
including subagent transcripts beside them) and Codex rollouts
(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Several files are summed, so a
project built across sessions is reported once.

    python3 scripts/session-stats.py SESSION.jsonl [...] [--from ISO] [--to ISO]

Active time adds up the gaps between consecutive events that are shorter than
--idle minutes (default 15), so overnight pauses and long reviews by the
person are not counted as agent work.
"""

import argparse
import collections
import datetime as dt
import json
import sys


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def read(path, start, end):
    events = []
    with open(path) as file:
        for line in file:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            stamp = event.get('timestamp')
            if not stamp:
                continue
            time = parse_time(stamp)
            if (start and time < start) or (end and time > end):
                continue
            events.append((time, event))
    return events


def claude(events, totals, models):
    usage = {}
    prompts = 0
    for _, event in events:
        message = event.get('message') or {}
        if event.get('type') == 'user' and not event.get('isSidechain') and not event.get('toolUseResult'):
            content = message.get('content')
            if isinstance(content, str) and not content.startswith('<'):
                prompts += 1
            elif isinstance(content, list) and any(part.get('type') in ('text', 'image') and not str(part.get('text', '')).startswith('<') for part in content if isinstance(part, dict) and part.get('type') != 'tool_result'):
                prompts += 1
        if event.get('type') == 'assistant' and message.get('usage'):
            # Streaming writes one line per content block with the same id.
            usage[message.get('id')] = (message.get('model'), message['usage'])
    for model, item in usage.values():
        models[model] += 1
        totals['input'] += item.get('input_tokens') or 0
        totals['cache_write'] += item.get('cache_creation_input_tokens') or 0
        totals['cache_read'] += item.get('cache_read_input_tokens') or 0
        totals['output'] += item.get('output_tokens') or 0
    return prompts


def codex(events, totals, models):
    last = None
    prompts = 0
    for _, event in events:
        payload = event.get('payload') or {}
        if event.get('type') == 'turn_context' and payload.get('model'):
            models[payload['model']] += 1
        if event.get('type') == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
            last = payload['info']['total_token_usage']
        if event.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
            text = ''.join(part.get('text', '') for part in payload.get('content', []))
            if text and not text.startswith('<') and not text.startswith('# AGENTS.md'):
                prompts += 1
    if last:
        cached = last.get('cached_input_tokens') or 0
        totals['input'] += (last.get('input_tokens') or 0) - cached
        totals['cache_read'] += cached
        totals['output'] += last.get('output_tokens') or 0
        totals['reasoning'] += last.get('reasoning_output_tokens') or 0
    return prompts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--from', dest='start', type=parse_time)
    parser.add_argument('--to', dest='end', type=parse_time)
    parser.add_argument('--idle', type=float, default=15)
    args = parser.parse_args()

    totals = collections.Counter()
    models = collections.Counter()
    times = []
    prompts = 0
    for path in args.files:
        events = read(path, args.start, args.end)
        if not events:
            continue
        times += [time for time, _ in events]
        is_codex = any(event.get('type') in ('session_meta', 'turn_context') for _, event in events[:5])
        prompts += (codex if is_codex else claude)(events, totals, models)
    if not times:
        sys.exit('no events in range')

    times.sort()
    idle = args.idle * 60
    active = sum(gap for gap in ((b - a).total_seconds() for a, b in zip(times, times[1:])) if gap < idle)
    total = totals['input'] + totals['cache_write'] + totals['cache_read'] + totals['output']
    print(f"models       {', '.join(m for m in models if m)}")
    print(f"span         {times[0].astimezone():%Y-%m-%d %H:%M} → {times[-1].astimezone():%Y-%m-%d %H:%M}")
    print(f"wall         {(times[-1] - times[0]).total_seconds() / 60:.0f} min")
    print(f"active       {active / 60:.0f} min (gaps under {args.idle:g} min)")
    print(f"prompts      {prompts}")
    print(f"input        {totals['input']:,} (uncached)")
    print(f"cache write  {totals['cache_write']:,}")
    print(f"cache read   {totals['cache_read']:,}")
    print(f"output       {totals['output']:,}" + (f" (reasoning {totals['reasoning']:,})" if totals['reasoning'] else ''))
    print(f"total        {total:,}")


if __name__ == '__main__':
    main()
