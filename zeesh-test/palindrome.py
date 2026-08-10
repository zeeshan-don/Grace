"""Simple palindrome checker.

Provides a function `is_palindrome` that returns ``True`` if the given string
reads the same forwards and backwards, ignoring case and non‑alphanumeric
characters.

When run as a script it demonstrates the function with two examples:
- a palindrome string
- a non‑palindrome string
"""
import re

def is_palindrome(s: str) -> bool:
    """Return ``True`` if *s* is a palindrome.

    The check is case‑insensitive and ignores any characters that are not
    letters or digits.
    """
    # Keep only alphanumeric characters and convert to lower case
    cleaned = re.sub(r"[^A-Za-z0-9]", "", s).lower()
    return cleaned == cleaned[::-1]

if __name__ == "__main__":
    examples = [
        "A man, a plan, a canal: Panama",  # palindrome
        "Hello, World!",                  # not a palindrome
    ]
    for txt in examples:
        print(f"{txt!r} -> {is_palindrome(txt)}")
