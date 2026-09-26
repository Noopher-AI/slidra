#!/usr/bin/env node
// slidra-validate: checks .slidra decks against the open format spec.
//
//   slidra-validate [--json] [--strict] [--quiet] <deck.slidra>...
//
// Exit status: 0 when every deck is valid (warnings allowed unless
// --strict), 1 when any deck has errors, 2 on a usage error.

import { runValidateCli } from "../lib/validate-cli.js";

process.exitCode = await runValidateCli(process.argv.slice(2));
