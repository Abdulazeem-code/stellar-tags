#!/usr/bin/env python3
"""Fail when added lines contain emoji or common AI boilerplate.

Only lines added between BASE and HEAD are checked, so existing files are not
flagged and contributors only answer for what they push.

Usage:
    python3 scripts/check-emoji.py [BASE] [HEAD]

BASE defaults to origin/main and HEAD to HEAD. Paths listed in SKIP_SUFFIXES
(lockfiles, images, generated bindings) are ignored.
"""

import re
import subprocess
import sys

# Pictographic ranges: emoticons, symbols and pictographs, transport, flags,
# supplemental symbols, misc symbols, dingbats, and the variation selector /
# zero-width joiner that glue emoji sequences together.
EMOJI = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U00002B00-\U00002BFF"
    "\U0000FE0F"
    "\U0000200D"
    "]"
)

# Phrases that only show up when chatbot output is pasted in verbatim.
SLOP = [
    "as an ai language model",
    "i hope this helps",
    "certainly! here",
    "here's the updated code",
    "lorem ipsum",
]

SKIP_SUFFIXES = (
    "package-lock.json",
    "Cargo.lock",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
)
SKIP_PREFIXES = ("packages/types/",)


def added_lines(base, head):
    diff = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", f"{base}...{head}"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stdout
    path = None
    lineno = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            target = raw[4:]
            path = None if target == "/dev/null" else target[2:]
            continue
        if raw.startswith("@@"):
            match = re.search(r"\+(\d+)", raw)
            lineno = int(match.group(1)) if match else 0
            continue
        if raw.startswith("+") and path:
            yield path, lineno, raw[1:]
            lineno += 1


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    head = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    problems = 0
    for path, lineno, text in added_lines(base, head):
        if path.endswith(SKIP_SUFFIXES) or path.startswith(SKIP_PREFIXES):
            continue
        if path == "scripts/check-emoji.py":
            continue
        found = EMOJI.findall(text)
        if found:
            chars = " ".join(f"U+{ord(c):04X}" for c in sorted(set(found)))
            print(f"::error file={path},line={lineno}::Emoji in added line ({chars})")
            problems += 1
        lowered = text.lower()
        for phrase in SLOP:
            if phrase in lowered:
                print(f"::error file={path},line={lineno}::AI boilerplate in added line: \"{phrase}\"")
                problems += 1
    if problems:
        print(f"{problems} problem(s). Remove emoji and pasted chatbot text before merging.")
        return 1
    print("No emoji or AI boilerplate in added lines.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
