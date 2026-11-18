---
title: "Intents: a request nobody addressed to the agent starts a workflow pipeline"
date: 2026-11-18
---

# Intents: a request nobody addressed to the agent starts a workflow pipeline

**Date:** 2026-11-18

## Problem

A team asks for a pull request review in its own words: a tag and a link at the root, "please review" in a thread reply, or "@Jane please review <link>" addressed to a colleague. The agent hears none of it until someone @mentions it. Two places in the router drop these messages: the colleague-mention branch, which also disengages the thread, and the final "thread not engaged" drop. Implicit engagement (phase 0 to 2) does not catch them either, because its ladder looks for the agent's name or a follow-up to the agent, and its classifier asks "is this said to the agent".

A workflow pipeline for a review already exists (`/workflow start review <link>`). What was missing is a way to start it from the request itself.

## Decision

A per-channel `intents` list in agent.yaml. Each intent names a yes or no `question`, a `pipeline`, optional `words`, and a `mode` (`shadow` by default).

- **Cheap check first.** A pull request link in the message, or a listed word in a thread reply whose thread holds a link. No model call otherwise, so a quiet or chatty channel costs nothing.
- **One question to the existing decision adapter.** `GateRunner.ask()` puts the intent's own question to the configured adapter, outside the gate's mode, memo and counters. Only a "yes" at or above `tAct` counts; every failure is a pass.
- **No model turn.** A confirmed message goes through `handleMessage` with `startPipeline`, which turns it into the `/workflow start` command from its author. Admission, ignore lists, `/1on1` locks and inbound rules run as for a mention; the pipeline's own prompts and approval gates decide what the review does.
- **Shared owner claim, own budget and cap.** The one-owner claim is the one implicit engagement uses, so the two never both act on a message. The daily budget and hourly cap have their own keys.
- **Checked before the colleague-mention branch.** A request addressed to a colleague starts the pipeline instead of disengaging the thread.

## Rejected

- **A scheduled sweep** (`/cron-add` every 15 minutes). Up to 15 minutes late, a turn every run on a quiet channel, and a cron run cannot read the channel with the built-in tools: `read_channel` is limited to the proactive Read list, `search_messages` needs a user token, and `get_thread_history` reads only the cron's own thread.
- **An implicit turn with a review prompt.** It needs prompt plumbing through the implicit note and repeats what the pipeline already does with approval gates.
- **Rules only** (a tag or a word list). The wording is open; a fixed tag misses most real requests.

## Open

- Tuning the budget and cap from real counts.
- An optional author list on an intent (who may trigger it), if a channel needs one.
