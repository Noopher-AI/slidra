---
name: slidra-reshape
description: Work through the pinned comments on the presentation one by one: do what you can, delete those comments; keep the text of what you cannot and ask. Use when the author's message starts with /slidra-reshape or asks you to "handle the comments"; text after the slash is just extra context — the list comes from comment list
---

# Handle comments one at a time

Comments are the only todo-list between the author and you: delete when done, keep and ask when you can't.

## Steps

1. **List all comments**: `slidra comment list <presentation-id>` (no `slide-path` means all slides). When it replies "0 total", report "No pinned comments right now" and change nothing.
2. **Process one at a time, finish one before starting the next**:
   - Read the comment's `target`: `page` means a whole-page request, any other value is an element identifier — first `slidra cat <presentation-id> slides/00N.svg` to confirm that id still exists.
   - **Can do it** (an existing command covers it and the target still exists): make the change with the corresponding command, then `slidra comment delete <presentation-id> slides/00N.svg <comment-id>` to delete the comment. A comment gets exactly what it asks for; other elements on the same page stay untouched.
   - **Cannot do it** (target no longer exists, no command covers the requested operation, or you can only produce a close-but-different result): keep the text, note that you will ask in the conversation. When the request is for a photo that doesn't exist, the right action is to ask — not to change the color to make do.
3. **After processing all of them**: ask one question per unhandled comment, explaining why it cannot be done. When a comment contains half-width single quotes that you need to put into a command argument, explain in the question which part cannot be typed in.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

First list what's done: `<comment-id> (page N): <what was done> — comment deleted`.
Then list what's kept: `<comment-id> (page N): <original text> — cannot do, reason: <reason>`, each with a one-line question attached.
