#!/usr/bin/env bash
#
# verify_refactor.sh — mechanical acceptance for a pure-move refactor commit.
#
# Every commit in a "split module X out of file Y" PR claims two things: (1)
# the lines that vanished from the old file are exactly the lines that
# appeared in the new file (nothing was rewritten along the way), and (2)
# where a symbol was renamed as part of the split, the only difference
# between old and new is the name itself. This script checks both claims
# against the commit's own diff, so review does not have to eyeball a
# thousand-line hunk to believe "verbatim move".
#
# Usage:
#   scripts/verify_refactor.sh moved <sha>...
#   scripts/verify_refactor.sh renamed <sha>...
#
# `moved <sha>...`
#   For each commit: take its full diff, strip the +/- prefix off every
#   added/removed content line (file-header +++/--- lines excluded), drop the
#   entries listed in the commit's own `Verbatim-move-exempt:` trailer (one
#   subtraction per listed line — see below), drop whitespace-only lines from
#   both sides, sort each side, and diff them. A pure move produces the same
#   bag of lines on both sides (each moved line was deleted from the old
#   spot and added at the new one) plus whatever the exempt trailer already
#   accounts for (new import/export lines the move needed, or an edited line
#   whose old and new text are both listed). Any leftover difference means
#   something changed content during the move, not just position — exit
#   non-zero and print what did not match.
#
# `renamed <sha>...`
#   For each commit: read its `Rename-map:` trailer (`old -> new`, one per
#   line). No trailer means this commit renamed nothing — exit 0. Otherwise,
#   for every file the commit touched, take the NEW blob, substitute every
#   `new` back to its `old` name (the exact reverse of the rename), and diff
#   that against the OLD blob. Line ranges listed in `Rename-exempt:` are
#   dropped from the comparison first (default side: new; `path:old:a-b`
#   selects the old side instead). Any residual diff after the reverse
#   substitution means the commit changed more than the name — exit non-zero.
#
# Trailers are plain commit-message text, not git-interpret-trailers syntax:
# a "Key:" line on its own, followed by indented entry lines, one per line.
# Exactly two leading spaces mark an entry line (the block's own structural
# indent); anything beyond those two spaces is the entry's own content,
# since an entry must match a diff line verbatim (diff strips only the
# leading +/-, never the line's indentation). Trailing whitespace is
# trimmed. Example:
#
#   Verbatim-move-exempt:
#     import { cornerPoint } from "./canvas/gesture-geometry.js";
#
#   Rename-map:
#     selectedIds -> selection.ids
#
#   Rename-exempt:
#     packages/web/src/canvas.ts:1310-1316
#
# Deliberately just bash + git + sort + diff + awk, plus perl for the
# rename substitution (sed's `\b` word boundary is a GNU extension that does
# not exist on macOS `sed`; perl is preinstalled everywhere this runs and is
# not a new dependency). No new package, nothing to `npm install`.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  verify_refactor.sh moved <sha>...
  verify_refactor.sh renamed <sha>...
EOF
}

# Prints the indented entry lines under a "<key>:" heading in a commit
# message, one per output line, trimmed, blank lines dropped. The block ends
# at the first line that is not indented (including a genuinely blank line).
#   $1 = commit message text (real newlines)
#   $2 = key, e.g. "Verbatim-move-exempt" (no trailing colon)
extract_trailer_block() {
  local msg="$1" key="$2"
  awk -v key="${key}:" '
    {
      line = $0
      trimmed = line
      sub(/^[ \t]+/, "", trimmed)
      sub(/[ \t]+$/, "", trimmed)
      if (trimmed == key) { in_block = 1; next }
      if (in_block) {
        # Exactly two leading spaces mark "still inside the block" (the
        # trailer own structural indent, matching the plan examples).
        # Only that fixed two-character prefix is stripped -- any FURTHER
        # leading whitespace is the source line own indentation and is
        # part of the entry content, since an entry must exact-match a
        # diff line that keeps its original indentation (only the leading
        # +/- is stripped there, nothing else).
        if (line ~ /^  /) {
          entry = line
          sub(/^  /, "", entry)
          sub(/[ \t]+$/, "", entry)
          if (entry != "") print entry
        } else {
          in_block = 0
        }
      }
    }
  ' <<<"$msg"
}

# Removes exactly the FIRST line equal to $2 from the newline-joined list in
# $1 and prints the rest, preserving order of the remaining lines.
remove_first_exact() {
  local haystack="$1" needle="$2"
  awk -v needle="$needle" '
    { if (!removed && $0 == needle) { removed = 1; next } print }
  ' <<<"$haystack"
}

line_present() {
  local haystack="$1" needle="$2"
  grep -qxF -- "$needle" <<<"$haystack"
}

cmd_moved() {
  local overall_rc=0 sha
  for sha in "$@"; do
    if ! git rev-parse -q --verify "${sha}^{commit}" >/dev/null 2>&1; then
      echo "moved: no such commit: $sha" >&2
      overall_rc=1
      continue
    fi

    local diff msg added removed
    diff="$(git show --format= --no-color "$sha")"
    msg="$(git show -s --format=%B "$sha")"
    # Added content lines: start with "+", excluding the "+++ " file header.
    added="$(grep -E '^\+' <<<"$diff" | grep -vE '^\+\+\+ ' | cut -c2-)"
    # Removed content lines: start with "-", excluding the "--- " file header.
    removed="$(grep -E '^-' <<<"$diff" | grep -vE '^--- ' | cut -c2-)"

    local exempt_entries missing=0
    exempt_entries="$(extract_trailer_block "$msg" "Verbatim-move-exempt")"
    if [ -n "$exempt_entries" ]; then
      while IFS= read -r entry; do
        [ -z "$entry" ] && continue
        if line_present "$added" "$entry"; then
          added="$(remove_first_exact "$added" "$entry")"
        elif line_present "$removed" "$entry"; then
          removed="$(remove_first_exact "$removed" "$entry")"
        else
          echo "moved: $sha: Verbatim-move-exempt entry not found on either side: $entry" >&2
          missing=1
        fi
      done <<<"$exempt_entries"
    fi
    if [ "$missing" = 1 ]; then
      overall_rc=1
      continue
    fi

    # Whitespace-only lines carry no content; count them on neither side.
    local added_sorted removed_sorted
    added_sorted="$(awk 'NF' <<<"$added" | sort)"
    removed_sorted="$(awk 'NF' <<<"$removed" | sort)"

    local delta
    if delta="$(diff <(printf '%s\n' "$added_sorted") <(printf '%s\n' "$removed_sorted"))"; then
      echo "moved: $sha: OK"
    else
      echo "moved: $sha: FAIL — added/removed content does not match after exemptions:" >&2
      echo "$delta" >&2
      overall_rc=1
    fi
  done
  return "$overall_rc"
}

# Applies every "old -> new" entry in $2 (newline-joined) to text $1, each
# occurrence of the NEW name replaced by the OLD name (the reverse of the
# rename this commit made).
reverse_rename() {
  local text="$1" map_entries="$2" out="$1"
  local entry old new
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    old="${entry%% -> *}"
    new="${entry##* -> }"
    out="$(perl -pe 's/\Q'"$new"'\E/'"$old"'/g' <<<"$out")"
  done <<<"$map_entries"
  printf '%s' "$out"
}

# Drops the lines in range start..end (1-based, inclusive) from $1.
drop_line_range() {
  local text="$1" start="$2" end="$3"
  awk -v s="$start" -v e="$end" 'NR < s || NR > e' <<<"$text"
}

cmd_renamed() {
  local overall_rc=0 sha
  for sha in "$@"; do
    if ! git rev-parse -q --verify "${sha}^{commit}" >/dev/null 2>&1; then
      echo "renamed: no such commit: $sha" >&2
      overall_rc=1
      continue
    fi

    local msg map_entries
    msg="$(git show -s --format=%B "$sha")"
    map_entries="$(extract_trailer_block "$msg" "Rename-map")"
    if [ -z "$map_entries" ]; then
      echo "renamed: $sha: no Rename-map: trailer — nothing to check"
      continue
    fi

    local exempt_entries
    exempt_entries="$(extract_trailer_block "$msg" "Rename-exempt")"

    local files file failed_file=0
    files="$(git show --format= --no-color --name-only "$sha")"
    while IFS= read -r file; do
      [ -z "$file" ] && continue

      local new_content old_content
      new_content="$(git show "${sha}:${file}" 2>/dev/null || true)"
      old_content="$(git show "${sha}^:${file}" 2>/dev/null || true)"
      # File was added or deleted whole in this commit (not a rename target on
      # both sides) — nothing to reverse-substitute against.
      if [ -z "$new_content" ] || [ -z "$old_content" ]; then
        continue
      fi

      local reversed="$new_content"
      reversed="$(reverse_rename "$reversed" "$map_entries")"

      # Rename-exempt entries for this file: "path:start-end" (new side,
      # default) or "path:old:start-end" (old side).
      if [ -n "$exempt_entries" ]; then
        while IFS= read -r entry; do
          [ -z "$entry" ] && continue
          case "$entry" in
            "$file:"*)
              local rest="${entry#"$file:"}"
              if [[ "$rest" == old:* ]]; then
                rest="${rest#old:}"
                local start="${rest%-*}" end="${rest#*-}"
                old_content="$(drop_line_range "$old_content" "$start" "$end")"
              else
                local start="${rest%-*}" end="${rest#*-}"
                reversed="$(drop_line_range "$reversed" "$start" "$end")"
              fi
              ;;
          esac
        done <<<"$exempt_entries"
      fi

      local delta
      if ! delta="$(diff <(printf '%s\n' "$reversed") <(printf '%s\n' "$old_content"))"; then
        echo "renamed: $sha: $file: FAIL — residual diff after reversing Rename-map:" >&2
        echo "$delta" >&2
        overall_rc=1
        failed_file=1
      fi
    done <<<"$files"

    if [ "$failed_file" = 0 ]; then
      echo "renamed: $sha: OK"
    fi
  done
  return "$overall_rc"
}

main() {
  if [ $# -lt 2 ]; then
    usage
    exit 1
  fi
  local sub="$1"
  shift
  case "$sub" in
    moved) cmd_moved "$@" ;;
    renamed) cmd_renamed "$@" ;;
    *)
      echo "verify_refactor.sh: unknown subcommand: $sub" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
